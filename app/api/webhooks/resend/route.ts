import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { withWebhook } from '@/lib/api/route';
import { getDb, schema } from '@/lib/db';
import { applyResendEvent, verifyResendSignature, type ResendEvent } from '@/lib/email/webhook';
import { log } from '@/lib/log';
import { getSecret } from '@/lib/settings/secrets';

const { webhookEvents } = schema;

/** §7A.8: public, and protected by its signature. Once a signature checks out, it always answers 200. */
export const POST = withWebhook(async (req) => {
  const db = getDb();
  const rawBody = await req.text();
  const id = req.headers.get('svix-id');
  const secret = await getSecret(db, 'RESEND_WEBHOOK_SECRET');
  const valid = Boolean(secret) && verifyResendSignature(rawBody, { id, timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature') }, secret!);

  if (!valid) {
    // Its own id, and no payload: an unsigned request must not be able to claim a real svix-id and block the real event.
    await db.insert(webhookEvents).values({ source: 'resend', externalId: `invalid:${uuidv7()}`, signatureOk: false });
    return Response.json({ error: { code: 'invalid_signature', message: 'Invalid signature' } }, { status: 401 });
  }

  const event = JSON.parse(rawBody) as ResendEvent;
  const [stored] = await db.insert(webhookEvents).values({ source: 'resend', externalId: id!, signatureOk: true, payloadJson: event }).onConflictDoNothing().returning({ id: webhookEvents.id });
  if (!stored) return Response.json({ ok: true, duplicate: true });

  try {
    await db.transaction(async (tx) => {
      await applyResendEvent(tx, event);
      await tx.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, stored.id));
    });
  } catch (err) {
    log.error('Resend webhook processing failed', { eventId: stored.id, type: event.type, err });
    await db.update(webhookEvents).set({ error: err instanceof Error ? err.message : 'Processing failed' }).where(eq(webhookEvents.id, stored.id));
  }
  return Response.json({ ok: true });
});
