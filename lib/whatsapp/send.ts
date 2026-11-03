import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { ApiError } from '@/lib/api/errors';
import { writeAudit } from '@/lib/api/route';
import { schema, type Db } from '@/lib/db';
import { releaseStaleSends, settleUnsent, type SendSummary } from '@/lib/email/send';
import { log } from '@/lib/log';
import { addSuppression } from '@/lib/suppression/service';
import type { WhatsAppPlan } from './audience';
import { failureFields } from './errors';
import { buildSendPayload, type SendPayload, type VariableMapping } from './payload';
import { WhatsAppApiError, type WhatsAppProvider } from './provider';
import type { TemplateShape } from './template-shape';

// Sends a selection now, inside one request, using the campaign tables, so its messages get the same webhook matching
// and history as a campaign's. Each request body is frozen into its row, so a retry sends exactly the same message, and
// rows are committed before Meta is called, because a status webhook can arrive before the call returns.

const { campaigns, campaignMessages, suppressionList } = schema;

const MAX_IN_FLIGHT = 10;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;
/** §8.5: fewer outcomes than this say nothing about the list. */
const BREAKER_MIN_OUTCOMES = 20;

type RunOptions = { messagesPerSecond: number; restrictedCountries: string[]; failurePercent: number; sleep?: (ms: number) => Promise<void> };
type Row = typeof campaignMessages.$inferSelect;
type Outcome = 'accepted' | 'failed' | 'stopped';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function createWhatsAppSend(db: Db, input: {
  template: { id: string; shape: TemplateShape };
  mapping: VariableMapping;
  plan: WhatsAppPlan;
  user: { id: string };
  includeUnknown: boolean;
  now?: Date;
}): Promise<string> {
  const { template, mapping, plan, user, includeUnknown, now = new Date() } = input;
  await releaseStaleSends(db, now, 'whatsapp');
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        channel: 'whatsapp',
        name: template.shape.payload.name,
        templateId: template.id,
        templateSnapshotJson: { template: template.shape.payload, body: template.shape.body },
        variableMappingJson: mapping,
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
    if (!campaign) throw new ApiError(409, 'send_in_progress', 'Another WhatsApp send is running. Try again when it finishes.');
    const values = plan.recipients.flatMap((contact) => {
      const id = uuidv7();
      const built = buildSendPayload(template.shape.payload, mapping, { ...contact, wa_to: contact.wa_to! }, id);
      if (!('body' in built)) return [];
      return [{ id, campaignId: campaign.id, contactId: contact.contact_id, channel: 'whatsapp', phoneE164: contact.phone_e164, paramsJson: built.body, timeZone: contact.time_zone, countryIso: contact.country_iso }];
    });
    if (values.length) await tx.insert(campaignMessages).values(values);
    return campaign.id;
  });
}

/** Only what §7.7 says is safe to repeat. Meta has no idempotency key, so anything that may have arrived isn't retried here. */
async function sendWithRetries(provider: WhatsAppProvider, body: SendPayload, sleep: (ms: number) => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.sendTemplate(body);
    } catch (err) {
      if (!(err instanceof WhatsAppApiError)) throw err;
      const { action } = err.rule;
      if ((action !== 'retry_backoff' && action !== 'retry_transient') || attempt >= MAX_RETRIES) throw err;
      await sleep(Math.min(2 ** attempt * 1000 * (1 + Math.random() / 2), MAX_BACKOFF_MS));
    }
  }
}

/** Saves the wamid. A webhook may have got here first, so this never lowers a status it set (§7.8). */
async function markAccepted(db: Db, row: Row, wamid: string, now: Date) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE campaign_messages SET
        status = CASE WHEN status IN ('sending', 'unknown') THEN 'accepted' ELSE status END,
        wamid = COALESCE(wamid, ${wamid}), accepted_at = COALESCE(accepted_at, ${now.toISOString()}::timestamptz), updated_at = now()
      WHERE id = ${row.id}`);
    await tx.execute(sql`INSERT INTO contact_activity (contact_id, last_marketing_at, last_campaign_id, total_sent)
      VALUES (${row.contactId}, ${now.toISOString()}::timestamptz, ${row.campaignId}, 1)
      ON CONFLICT (contact_id) DO UPDATE SET last_marketing_at = EXCLUDED.last_marketing_at, last_campaign_id = EXCLUDED.last_campaign_id, total_sent = contact_activity.total_sent + 1`);
  });
}

const columnsFor = (err: WhatsAppApiError) => {
  const fields = err.graph ? failureFields(err.graph) : { error_code: err.networkError ?? (err.status ? String(err.status) : 'network_error'), error_subcode: null, error_title: err.message, error_detail: null, fbtrace_id: null };
  return { errorCode: fields.error_code, errorSubcode: fields.error_subcode, errorTitle: fields.error_title, errorDetail: fields.error_detail ?? err.message, fbtraceId: fields.fbtrace_id };
};

function stopMessage(err: unknown): string {
  if (!(err instanceof WhatsAppApiError)) return 'The send stopped unexpectedly. Check the Activity log before sending again.';
  const { action, banner } = err.rule;
  if (banner === 'token') return `Meta refused the access token: ${err.message} Update it in Settings → WhatsApp.`;
  if (banner === 'permission') return `Meta says the access token is missing a permission: ${err.message}`;
  if (banner === 'quality') return `Meta has paused or disabled this template: ${err.message}`;
  if (action === 'pause_campaign') return `Meta refused this template: ${err.message} Sync your templates and check the variables.`;
  if (action === 'stop_all_campaigns') return `Meta has blocked this WhatsApp account: ${err.message} Check WhatsApp Manager before sending again.`;
  if (action === 'retry_backoff') return `Meta is rate limiting this number: ${err.message} Send the rest later.`;
  return `Meta couldn’t be reached: ${err.message} Some messages may have gone out, so check them before sending again.`;
}

/** Applies §7.7 to one failed row. Returns whether the whole send has to stop. */
async function recordFailure(db: Db, row: Row, err: WhatsAppApiError, now: Date): Promise<boolean> {
  const rule = err.rule;
  const columns = columnsFor(err);
  const fail = () => db.update(campaignMessages).set({ status: 'failed', failedAt: now, updatedAt: now, ...columns }).where(eq(campaignMessages.id, row.id));
  switch (rule.action) {
    case 'failed':
    case 'failed_manual_retry_after_24h':
    // Pair rate limit: this person alone, so the send carries on. There's no waiting 60 s inside one request.
    case 'retry_after_60s':
      await fail();
      return false;
    case 'failed_and_suppress':
      await db.transaction(async (tx) => {
        await tx.update(campaignMessages).set({ status: 'failed', failedAt: now, updatedAt: now, ...columns }).where(eq(campaignMessages.id, row.id));
        if (row.phoneE164 && rule.suppression_reason) {
          await addSuppression(tx, { channel: 'whatsapp', identifier: row.phoneE164, reason: rule.suppression_reason, source: row.campaignId, createdBy: 'system:send' });
          await writeAudit(tx, { id: 'system:send' }, 'whatsapp.suppressed', 'campaign_message', { entityId: row.id, channel: 'whatsapp', details: { reason: rule.suppression_reason } });
        }
      });
      return false;
    case 'pause_campaign':
    case 'stop_all_campaigns':
      await fail();
      return true;
    default: {
      // Retries ran out, or the outcome isn't known. A failure before sending, or a rate limit, is certain not to have gone out.
      const certainlyNotSent = rule.action === 'retry_backoff' || err.networkError?.endsWith('_BEFORE_REQUEST_SENT');
      await db.update(campaignMessages).set({ status: certainlyNotSent ? 'pending' : 'unknown', updatedAt: now, ...columns }).where(eq(campaignMessages.id, row.id));
      return true;
    }
  }
}

async function sendPending(db: Db, campaignId: string, provider: WhatsAppProvider, { messagesPerSecond, restrictedCountries, failurePercent, sleep = defaultSleep }: RunOptions): Promise<{ stop: unknown } | null> {
  const chunkSize = Math.max(1, Math.min(MAX_IN_FLIGHT, Math.floor(messagesPerSecond)));
  const restricted = new Set(restrictedCountries);
  let outcomes = 0;
  let failures = 0;

  for (;;) {
    const rows = await db.select().from(campaignMessages).where(and(eq(campaignMessages.campaignId, campaignId), eq(campaignMessages.status, 'pending'))).orderBy(asc(campaignMessages.id)).limit(chunkSize);
    if (!rows.length) return null;
    const startedAt = Date.now();
    await db.update(campaigns).set({ heartbeatAt: new Date() }).where(eq(campaigns.id, campaignId));

    // §5.8: checked again just before sending, because someone may have replied STOP since the send was created.
    const phones = rows.map((r) => r.phoneE164!);
    const suppressed = new Set((await db.select({ phone: suppressionList.phoneE164 }).from(suppressionList).where(inArray(suppressionList.phoneE164, phones))).map((r) => r.phone));
    const ready: Row[] = [];
    for (const row of rows) {
      const reason = suppressed.has(row.phoneE164!) ? 'SUPPRESSED' : row.countryIso && restricted.has(row.countryIso) ? 'RESTRICTED_COUNTRY' : null;
      if (reason) await db.update(campaignMessages).set({ status: 'skipped', errorCode: reason, updatedAt: new Date() }).where(eq(campaignMessages.id, row.id));
      else ready.push(row);
    }
    if (!ready.length) continue;

    await db
      .update(campaignMessages)
      .set({ status: 'sending', claimToken: uuidv7(), claimedAt: new Date(), attempts: sql`${campaignMessages.attempts} + 1`, updatedAt: new Date() })
      .where(inArray(campaignMessages.id, ready.map((r) => r.id)));

    let stop: unknown = null;
    const results = await Promise.all(
      ready.map(async (row): Promise<Outcome> => {
        try {
          const { wamid } = await sendWithRetries(provider, row.paramsJson as SendPayload, sleep);
          await markAccepted(db, row, wamid, new Date());
          return 'accepted';
        } catch (err) {
          if (!(err instanceof WhatsAppApiError)) {
            await db.update(campaignMessages).set({ status: 'unknown', errorCode: 'internal_error', updatedAt: new Date() }).where(eq(campaignMessages.id, row.id));
            stop ??= err;
            return 'stopped';
          }
          if (await recordFailure(db, row, err, new Date())) {
            stop ??= err;
            return 'stopped';
          }
          return 'failed';
        }
      }),
    );
    if (stop) return { stop };

    outcomes += results.length;
    failures += results.filter((r) => r === 'failed').length;
    if (outcomes >= BREAKER_MIN_OUTCOMES && (failures / outcomes) * 100 > failurePercent) {
      return { stop: new Error(`circuit_breaker:${Math.round((failures / outcomes) * 100)}`) };
    }
    const wait = (results.length / messagesPerSecond) * 1000 - (Date.now() - startedAt);
    if (wait > 0) await sleep(wait);
  }
}

export async function runWhatsAppSend(db: Db, campaignId: string, provider: WhatsAppProvider, options: RunOptions): Promise<SendSummary> {
  let stopped: { stop: unknown } | null;
  try {
    stopped = await sendPending(db, campaignId, provider, options);
  } catch (err) {
    log.error('WhatsApp send failed', { campaignId, err });
    stopped = { stop: err };
  }
  const breaker = stopped?.stop instanceof Error && stopped.stop.message.startsWith('circuit_breaker:') ? stopped.stop.message.split(':')[1] : null;
  const stopped_reason = !stopped ? null : breaker ? `Stopped to protect your number: ${breaker}% of messages failed, above your limit of ${options.failurePercent}%. Check the failures before sending again.` : stopMessage(stopped.stop);

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
