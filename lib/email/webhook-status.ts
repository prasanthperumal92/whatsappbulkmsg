import { and, desc, eq } from 'drizzle-orm';
import { schema, type Tx } from '@/lib/db';
import { appUrl, getEnvironment } from '@/lib/env';
import { credentialSources } from '@/lib/settings/secrets';

// §5.2: what S-01's webhook card shows, so nothing is typed by hand when connecting Resend.

const { webhookEvents } = schema;

export const WEBHOOK_PATH = '/api/webhooks/resend';
export const WEBHOOK_EVENTS = ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.opened', 'email.clicked', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed'];

export type WebhookNotice = 'localhost' | 'preview' | null;

export async function emailWebhookStatus(db: Tx, requestUrl: string, env: Record<string, string | undefined> = process.env) {
  const url = `${appUrl(requestUrl, env)}${WEBHOOK_PATH}`;
  const lastOf = (signatureOk: boolean) =>
    db
      .select({ at: webhookEvents.receivedAt, payload: webhookEvents.payloadJson })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, 'resend'), eq(webhookEvents.signatureOk, signatureOk)))
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(1);
  const [received] = await lastOf(true);
  const [rejected] = await lastOf(false);
  const notice: WebhookNotice = /\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url) ? 'localhost' : getEnvironment(env) === 'preview' ? 'preview' : null;
  return {
    url,
    events: WEBHOOK_EVENTS,
    notice,
    secret_set: (await credentialSources(db, env)).RESEND_WEBHOOK_SECRET !== 'none',
    last_event_at: received?.at.toISOString() ?? null,
    last_event_type: (received?.payload as { type?: string } | null)?.type ?? null,
    // Only worth raising if nothing has got through since: it usually means the signing secret doesn't match.
    rejected_at: rejected && (!received || rejected.at > received.at) ? rejected.at.toISOString() : null,
  };
}
export type EmailWebhookStatus = Awaited<ReturnType<typeof emailWebhookStatus>>;
