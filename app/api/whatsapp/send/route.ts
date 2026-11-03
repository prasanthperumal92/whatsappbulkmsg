import { z } from 'zod';
import { ApiError, parseJson } from '@/lib/api/errors';
import { withAudit } from '@/lib/api/route';
import { getDb } from '@/lib/db';
import { UNKNOWN_ACK } from '@/lib/email/shared';
import { prepareWhatsAppSend, whatsappRequest } from '@/lib/whatsapp/preview';
import { createWhatsAppSend, runWhatsAppSend } from '@/lib/whatsapp/send';

const body = whatsappRequest.extend({
  template_id: z.string().max(100),
  /** The count the sender saw. If the audience has changed since, they should see the new one first. */
  expected_recipients: z.number().int().min(1),
  unknown_ack: z.string().optional(),
});

export const POST = withAudit({ action: 'whatsapp.send', entity: 'campaign' }, async (req, { user, audit }) => {
  const input = await parseJson(req, body);
  if (input.include_unknown && input.unknown_ack !== UNKNOWN_ACK) throw new ApiError(400, 'acknowledgement_required', `Type ${UNKNOWN_ACK} to include contacts with unknown consent.`);

  // Not the route's transaction: rows must be committed before Meta is called, so webhooks can find them, and a failure
  // after sending must not roll back the record of what was sent.
  const db = getDb();
  const { plan, provider, template, settings, problems } = await prepareWhatsAppSend(db, input);
  if (problems.length) throw new ApiError(409, 'not_ready', problems[0]!);
  if (plan.recipients.length !== input.expected_recipients) throw new ApiError(409, 'audience_changed', `This selection now reaches ${plan.recipients.length} ${plan.recipients.length === 1 ? 'person' : 'people'}, not ${input.expected_recipients}. Check the new count and send again.`);

  const campaignId = await createWhatsAppSend(db, { template: { id: template!.row.id, shape: template!.shape }, mapping: input.mapping, plan, user, includeUnknown: input.include_unknown });
  const { messagesPerSecond, restrictedCountries, circuitBreakerFailurePercent } = settings.whatsappSending;
  const summary = await runWhatsAppSend(db, campaignId, provider!, { messagesPerSecond, restrictedCountries, failurePercent: circuitBreakerFailurePercent });
  audit({
    entityId: campaignId,
    channel: 'whatsapp',
    details: { template: template!.row.name, selected: plan.selected, recipients: plan.recipients.length, excluded: plan.excluded, include_unknown: input.include_unknown, accepted: summary.accepted, failed: summary.failed, skipped: summary.skipped, unknown: summary.unknown, provider: provider!.kind },
  });
  return Response.json(summary);
});
