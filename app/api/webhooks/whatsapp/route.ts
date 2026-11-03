import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { withWebhook } from '@/lib/api/route';
import { getDb, schema } from '@/lib/db';
import { log } from '@/lib/log';
import { getSecret } from '@/lib/settings/secrets';
import { applyMetaPayload, safeEqual, verifyMetaSignature, whatsappVerifyToken, type MetaPayload } from '@/lib/whatsapp/webhook';

const { webhookEvents } = schema;

/** §7.8: Meta's verification handshake. */
export const GET = withWebhook(async (req) => {
  const params = new URL(req.url).searchParams;
  const expected = await whatsappVerifyToken(getDb());
  const token = params.get('hub.verify_token');
  if (params.get('hub.mode') !== 'subscribe' || !expected || !token || !safeEqual(token, expected)) return new Response('Forbidden', { status: 403 });
  return new Response(params.get('hub.challenge') ?? '', { headers: { 'content-type': 'text/plain' } });
});

/** §7.8: public, and protected by its signature. Once a signature checks out, it always answers 200. */
export const POST = withWebhook(async (req) => {
  const db = getDb();
  const rawBody = await req.text();
  const secret = await getSecret(db, 'META_APP_SECRET');
  if (!secret || !verifyMetaSignature(rawBody, req.headers.get('x-hub-signature-256'), secret)) {
    // No payload is kept from an unsigned request, and its own id means it can't block a real event.
    await db.insert(webhookEvents).values({ source: 'meta', externalId: `invalid:${uuidv7()}`, signatureOk: false });
    return Response.json({ error: { code: 'invalid_signature', message: 'Invalid signature' } }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as MetaPayload;
  const externalId = createHash('sha256').update(rawBody).digest('hex');
  const [stored] = await db.insert(webhookEvents).values({ source: 'meta', externalId, signatureOk: true, payloadJson: payload }).onConflictDoNothing().returning({ id: webhookEvents.id });
  if (!stored) return Response.json({ ok: true, duplicate: true });

  try {
    await db.transaction(async (tx) => {
      await applyMetaPayload(tx, payload);
      await tx.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, stored.id));
    });
  } catch (err) {
    log.error('WhatsApp webhook processing failed', { eventId: stored.id, err });
    await db.update(webhookEvents).set({ error: err instanceof Error ? err.message : 'Processing failed' }).where(eq(webhookEvents.id, stored.id));
  }
  return Response.json({ ok: true });
});
