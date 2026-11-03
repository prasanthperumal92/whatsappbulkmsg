import { and, desc, eq } from 'drizzle-orm';
import { schema, type Tx } from '@/lib/db';
import { appUrl, getEnvironment } from '@/lib/env';
import { credentialSources } from '@/lib/settings/secrets';
import { WEBHOOK_FIELDS } from './shared';
import { whatsappVerifyToken } from './webhook';

// §5.2: what S-01's webhook card shows, so nothing is typed by hand when connecting Meta.

const { webhookEvents } = schema;
export const WHATSAPP_WEBHOOK_PATH = '/api/webhooks/whatsapp';

export async function whatsappWebhookStatus(db: Tx, requestUrl: string, env: Record<string, string | undefined> = process.env) {
  const url = `${appUrl(requestUrl, env)}${WHATSAPP_WEBHOOK_PATH}`;
  const lastOf = (signatureOk: boolean) => db.select({ at: webhookEvents.receivedAt }).from(webhookEvents).where(and(eq(webhookEvents.source, 'meta'), eq(webhookEvents.signatureOk, signatureOk))).orderBy(desc(webhookEvents.receivedAt)).limit(1);
  const [received] = await lastOf(true);
  const [rejected] = await lastOf(false);
  return {
    url,
    verify_token: await whatsappVerifyToken(db, env),
    fields: WEBHOOK_FIELDS,
    notice: /\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url) ? ('localhost' as const) : getEnvironment(env) === 'preview' ? ('preview' as const) : null,
    secret_set: (await credentialSources(db, env)).META_APP_SECRET !== 'none',
    last_event_at: received?.at.toISOString() ?? null,
    // Only worth raising if nothing has got through since: it usually means the App Secret doesn't match.
    rejected_at: rejected && (!received || rejected.at > received.at) ? rejected.at.toISOString() : null,
  };
}
export type WhatsAppWebhookStatus = Awaited<ReturnType<typeof whatsappWebhookStatus>>;
