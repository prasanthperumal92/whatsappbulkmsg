import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { ApiError } from '@/lib/api/errors';
import type { ContactRow } from '@/lib/contacts/store';
import { schema, type Db, type Tx } from '@/lib/db';
import { log } from '@/lib/log';
import type { Settings } from '@/lib/settings/schema';
import type { AudiencePlan } from './audience';
import { COMPOSE_MAPPING, fromHeader, toTemplate, type Composition } from './compose';
import { classifyEmailError } from './errors';
import { buildEmailElement, type EmailBatchElement, type EmailSettings, type EmailTemplate } from './payload';
import { EmailProviderError, type EmailProvider } from './provider';

// Sends a selection now, inside one request, using the campaign tables, so its messages get the same unsubscribe
// links, webhook matching and history as a campaign's. Rows are committed before each call to Resend: a link clicked,
// or a webhook received, straight after sending has to find its row. Size is bounded by MAX_DIRECT_RECIPIENTS.

const { campaigns, campaignMessages, emailSuppressionList } = schema;

const BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;
/** A send this far past its last batch died with its function, so it can't still be holding the channel. */
export const STALE_SEND_MS = 15 * 60 * 1000;

type Snapshot = { template: EmailTemplate; settings: Omit<EmailSettings, 'app_url'> & { app_url: string } };
export type SendSummary = {
  campaign_id: string;
  accepted: number;
  failed: number;
  skipped: number;
  unknown: number;
  /** Why the send stopped early, in words a person can act on. */
  stopped_reason: string | null;
};
type RunOptions = { secret: string; sleep?: (ms: number) => Promise<void>; requestsPerSecond?: number };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The fields §5.2 requires before anything can be sent, as messages for the send form. */
export function missingSenderSettings({ fromName, fromAddress, postalAddress }: Settings['email']): string[] {
  return [
    ...(fromName && fromAddress ? [] : ['Add a from name and from address in Settings → Email.']),
    ...(postalAddress?.trim() ? [] : ['Add your business address in Settings → Signature and address. Marketing emails must include it.']),
  ];
}

/** The fields of a contact a composed email can use, frozen so a retry renders the same bytes. */
const paramsOf = (contact: ContactRow) => Object.fromEntries(Object.values(COMPOSE_MAPPING).flatMap((s) => ('field' in s ? [[s.field, contact[s.field as keyof ContactRow] ?? null]] : [])));

export function emailSettingsFrom(settings: Pick<Settings, 'email' | 'audience'>, app_url: string): EmailSettings {
  const { fromName, fromAddress, replyTo, postalAddress, signature } = settings.email;
  return {
    from: fromHeader(fromName!, fromAddress!),
    reply_to: replyTo,
    postal_address: postalAddress!,
    signature,
    privacy_url: settings.audience.privacyNoticeUrl,
    app_url,
  };
}

/** A send whose function died mid-way stops holding the channel. Rows that were in flight may have gone out. */
async function releaseStaleSends(db: Db, now: Date) {
  await db.transaction(async (tx) => {
    const stale = await tx
      .update(campaigns)
      .set({ status: 'failed', finishedAt: now, pauseReason: 'The send was interrupted' })
      .where(and(eq(campaigns.channel, 'email'), eq(campaigns.status, 'running'), sql`${campaigns.workflowRunId} IS NULL`, lt(campaigns.heartbeatAt, new Date(now.getTime() - STALE_SEND_MS))))
      .returning({ id: campaigns.id });
    if (stale.length) await settleUnsent(tx, stale.map((c) => c.id));
  });
}

async function settleUnsent(tx: Tx, ids: string[]) {
  await tx.update(campaignMessages).set({ status: 'unknown', updatedAt: new Date() }).where(and(inArray(campaignMessages.campaignId, ids), eq(campaignMessages.status, 'sending')));
  await tx.update(campaignMessages).set({ status: 'skipped', errorCode: 'SEND_STOPPED', updatedAt: new Date() }).where(and(inArray(campaignMessages.campaignId, ids), eq(campaignMessages.status, 'pending')));
}

/** Freezes the recipients and takes the channel's one running slot (§8.7), so two sends can't overlap and both pass the caps. */
export async function createEmailSend(db: Db, input: {
  composition: Composition;
  plan: AudiencePlan;
  settings: EmailSettings;
  user: { id: string; email?: string | null };
  includeUnknown: boolean;
  now?: Date;
}): Promise<string> {
  const { composition, plan, settings, user, includeUnknown, now = new Date() } = input;
  const template = toTemplate(composition);
  await releaseStaleSends(db, now);
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        channel: 'email',
        name: composition.subject,
        templateSnapshotJson: { template, settings } satisfies Snapshot,
        variableMappingJson: COMPOSE_MAPPING,
        status: 'running',
        includeUnknown,
        includeUnknownAckBy: includeUnknown ? user.id : null,
        includeUnknownAckAt: includeUnknown ? now : null,
        total: plan.recipients.length,
        createdBy: user.id,
        heartbeatAt: now,
        startedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: campaigns.id });
    if (!campaign) throw new ApiError(409, 'send_in_progress', 'Another email send is running. Try again when it finishes.');
    await tx.insert(campaignMessages).values(
      plan.recipients.map((contact) => ({
        id: uuidv7(),
        campaignId: campaign.id,
        contactId: contact.contact_id,
        channel: 'email',
        emailTo: contact.email,
        paramsJson: paramsOf(contact),
        timeZone: contact.time_zone,
        countryIso: contact.country_iso,
      })),
    );
    return campaign.id;
  });
}

async function withRetries<T>(call: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof EmailProviderError) || classifyEmailError(err) !== 'retry' || attempt >= MAX_RETRIES) throw err;
      const backoff = err.retryAfter ? err.retryAfter * 1000 : 2 ** attempt * 1000 * (1 + Math.random() / 2);
      await sleep(Math.min(backoff, MAX_BACKOFF_MS));
    }
  }
}

const failureColumns = (err: unknown) =>
  err instanceof EmailProviderError
    ? { errorCode: err.code ?? (err.status === null ? 'network_error' : String(err.status)), errorTitle: err.code, errorDetail: err.message }
    : { errorCode: 'internal_error', errorTitle: null, errorDetail: 'The send stopped unexpectedly' };

/** Saves Resend's id. A webhook may have got here first, so this never lowers a status it set (ES-27). */
async function markAccepted(db: Db, campaignId: string, sent: { id: string; contactId: string; resendId: string }[], now: Date) {
  await db.transaction(async (tx) => {
    for (const { id, contactId, resendId } of sent) {
      await tx.execute(sql`UPDATE campaign_messages SET
          status = CASE WHEN status IN ('sending', 'unknown') THEN 'accepted' ELSE status END,
          resend_id = ${resendId}, accepted_at = COALESCE(accepted_at, ${now.toISOString()}::timestamptz), updated_at = now()
        WHERE id = ${id}`);
      await tx.execute(sql`INSERT INTO contact_activity (contact_id, last_email_at, last_email_campaign_id, total_emails)
        VALUES (${contactId}, ${now.toISOString()}::timestamptz, ${campaignId}, 1)
        ON CONFLICT (contact_id) DO UPDATE SET last_email_at = EXCLUDED.last_email_at, last_email_campaign_id = EXCLUDED.last_email_campaign_id, total_emails = contact_activity.total_emails + 1`);
    }
  });
}

function stopMessage(err: unknown): string {
  if (!(err instanceof EmailProviderError)) return 'The send stopped unexpectedly. Check the Activity log before sending again.';
  if (err.status === 401 || err.code === 'invalid_api_key' || err.code === 'missing_api_key' || err.code === 'restricted_api_key') return `Resend refused the API key: ${err.message} Update it in Settings → Email.`;
  if (err.code === 'daily_quota_exceeded' || err.code === 'monthly_quota_exceeded') return `Your Resend sending quota is used up: ${err.message}`;
  if (classifyEmailError(err) === 'retry') return `Resend couldn't be reached: ${err.message} Some emails in the last batch may have gone out, so check them before sending again.`;
  return `Resend refused the send: ${err.message}`;
}

/** Stops the whole send unless it's one row's own problem. Returns the reason to stop, or null to carry on. */
async function sendRowsOneByOne(db: Db, campaignId: string, batch: { row: { id: string; contactId: string }; element: EmailBatchElement }[], provider: EmailProvider, sleep: (ms: number) => Promise<void>): Promise<{ stop: unknown } | null> {
  for (const { row, element } of batch) {
    try {
      const resendId = await withRetries(() => provider.sendOne(element, `msg_${row.id}`), sleep);
      await markAccepted(db, campaignId, [{ id: row.id, contactId: row.contactId, resendId }], new Date());
    } catch (err) {
      if (!(err instanceof EmailProviderError) || classifyEmailError(err) !== 'split') return { stop: err };
      await db.update(campaignMessages).set({ status: 'failed', failedAt: new Date(), attempts: sql`${campaignMessages.attempts} + 1`, updatedAt: new Date(), ...failureColumns(err) }).where(eq(campaignMessages.id, row.id));
    }
  }
  return null;
}

async function sendPending(db: Db, campaignId: string, snapshot: Snapshot, provider: EmailProvider, { secret, sleep = defaultSleep, requestsPerSecond = 2 }: RunOptions): Promise<{ stop: unknown } | null> {
  const gap = 1000 / requestsPerSecond;
  for (;;) {
    const rows = await db.select().from(campaignMessages).where(and(eq(campaignMessages.campaignId, campaignId), eq(campaignMessages.status, 'pending'))).orderBy(asc(campaignMessages.id)).limit(BATCH_SIZE);
    if (!rows.length) return null;
    await db.update(campaigns).set({ heartbeatAt: new Date() }).where(eq(campaigns.id, campaignId));

    // §5.8: checked again just before sending, because someone may have unsubscribed since the send was created.
    const addresses = rows.map((r) => r.emailTo!);
    const suppressed = new Set((await db.select({ email: emailSuppressionList.email }).from(emailSuppressionList).where(inArray(emailSuppressionList.email, addresses))).map((r) => r.email));

    const built = await Promise.all(
      rows.map(async (row) => ({
        row,
        result: suppressed.has(row.emailTo!)
          ? ({ skip_reason: 'SUPPRESSED' } as const)
          : await buildEmailElement({
              template: snapshot.template,
              mapping: COMPOSE_MAPPING,
              contact: { email: row.emailTo, ...(row.paramsJson as Record<string, unknown>) },
              settings: snapshot.settings,
              secret,
              message_id: row.id,
              campaign_id: campaignId,
            }),
      })),
    );
    const batch = built.flatMap(({ row, result }) => ('element' in result ? [{ row, element: result.element }] : []));
    const skips = built.flatMap(({ row, result }) => ('skip_reason' in result ? [{ id: row.id, reason: result.skip_reason }] : []));
    for (const { id, reason } of skips) {
      await db.update(campaignMessages).set({ status: 'skipped', errorCode: reason, updatedAt: new Date() }).where(eq(campaignMessages.id, id));
    }
    if (!batch.length) continue;

    const claimToken = uuidv7();
    const batchKey = `cmp_${campaignId}_b_${claimToken}`;
    await db
      .update(campaignMessages)
      .set({ status: 'sending', claimToken, claimedAt: new Date(), batchKey, attempts: sql`${campaignMessages.attempts} + 1`, updatedAt: new Date() })
      .where(inArray(campaignMessages.id, batch.map((b) => b.row.id)));

    try {
      const ids = await withRetries(() => provider.sendBatch(batch.map((b) => b.element), batchKey), sleep);
      await markAccepted(db, campaignId, batch.map((b, i) => ({ id: b.row.id, contactId: b.row.contactId, resendId: ids[i]! })), new Date());
    } catch (err) {
      if (err instanceof EmailProviderError && classifyEmailError(err) === 'split') {
        // §7A.7: strict validation refuses the whole batch and sends nothing, so one bad row can't sink the others.
        const stopped = await sendRowsOneByOne(db, campaignId, batch, provider, sleep);
        if (stopped) return stopped;
      } else {
        const definite = err instanceof EmailProviderError && classifyEmailError(err) === 'stop';
        // A refusal sent nothing. A timeout may have sent everything, so those rows are unknown, not failed (§8.1).
        await db
          .update(campaignMessages)
          .set(definite ? { status: 'failed', failedAt: new Date(), updatedAt: new Date(), ...failureColumns(err) } : { status: 'unknown', updatedAt: new Date(), ...failureColumns(err) })
          .where(and(eq(campaignMessages.campaignId, campaignId), eq(campaignMessages.status, 'sending')));
        return { stop: err };
      }
    }
    await sleep(gap);
  }
}

export async function runEmailSend(db: Db, campaignId: string, provider: EmailProvider, options: RunOptions): Promise<SendSummary> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new ApiError(404, 'not_found', 'This send no longer exists.');

  let stopped: { stop: unknown } | null;
  try {
    stopped = await sendPending(db, campaignId, campaign.templateSnapshotJson as Snapshot, provider, options);
  } catch (err) {
    log.error('Email send failed', { campaignId, err });
    stopped = { stop: err };
  }
  const stopped_reason = stopped ? stopMessage(stopped.stop) : null;

  await db.transaction(async (tx) => {
    if (stopped) await settleUnsent(tx, [campaignId]);
    await tx.update(campaigns).set({ status: stopped ? 'failed' : 'completed', finishedAt: new Date(), pauseReason: stopped_reason }).where(eq(campaigns.id, campaignId));
  });

  const { rows } = await db.execute<{ status: string; n: number }>(sql`SELECT status, count(*)::int AS n FROM campaign_messages WHERE campaign_id = ${campaignId} GROUP BY status`);
  const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
  const failed = count('failed');
  const skipped = count('skipped');
  const unknown = count('unknown');
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  return { campaign_id: campaignId, accepted: total - failed - skipped - unknown, failed, skipped, unknown, stopped_reason };
}
