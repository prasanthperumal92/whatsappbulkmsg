import { z } from 'zod';
import { ApiError, parseJson } from '@/lib/api/errors';
import { withAudit } from '@/lib/api/route';
import { composition } from '@/lib/email/compose';
import { audienceRequest, prepareSend, refuseIfBlocked } from '@/lib/email/preview';
import { createEmailSend, emailSettingsFrom, runEmailSend } from '@/lib/email/send';
import { UNKNOWN_ACK } from '@/lib/email/shared';
import { getDb } from '@/lib/db';

const body = audienceRequest.extend({
  ...composition.shape,
  /** The count the sender saw. If the audience has changed since, they should see the new one first. */
  expected_recipients: z.number().int().min(1),
  unknown_ack: z.string().optional(),
});

export const POST = withAudit({ action: 'email.send', entity: 'campaign' }, async (req, { user, audit }) => {
  const input = await parseJson(req, body);
  if (input.include_unknown && input.unknown_ack !== UNKNOWN_ACK) throw new ApiError(400, 'acknowledgement_required', `Type ${UNKNOWN_ACK} to include contacts with unknown consent.`);

  // Not the route's transaction: each batch's rows must be committed before Resend is called, so unsubscribe links and
  // webhooks work straight away, and a failure after sending must not roll back the record of what was sent.
  const db = getDb();
  const prepared = await prepareSend(db, input, req.url);
  refuseIfBlocked(prepared);
  const { plan, settings, provider, secret, url } = prepared;
  if (plan.recipients.length !== input.expected_recipients) throw new ApiError(409, 'audience_changed', `This selection now reaches ${plan.recipients.length} ${plan.recipients.length === 1 ? 'person' : 'people'}, not ${input.expected_recipients}. Check the new count and send again.`);

  const campaignId = await createEmailSend(db, {
    composition: { subject: input.subject, body: input.body },
    plan,
    settings: emailSettingsFrom(settings, url),
    user,
    includeUnknown: input.include_unknown,
  });
  const summary = await runEmailSend(db, campaignId, provider!, { secret: secret!, requestsPerSecond: settings.emailSending.batchRequestsPerSecond });
  audit({
    entityId: campaignId,
    channel: 'email',
    details: { selected: plan.selected, recipients: plan.recipients.length, excluded: plan.excluded, include_unknown: input.include_unknown, accepted: summary.accepted, failed: summary.failed, skipped: summary.skipped, unknown: summary.unknown, provider: provider!.kind },
  });
  return Response.json(summary);
});
