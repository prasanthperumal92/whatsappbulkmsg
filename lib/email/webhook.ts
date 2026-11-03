import { eq, sql } from 'drizzle-orm';
import { Webhook } from 'svix';
import { writeAudit } from '@/lib/api/route';
import { schema, type Tx } from '@/lib/db';
import { addSuppression } from '@/lib/suppression/service';
import { reduceEmailStatus, type EmailStatus } from './status';

// §7A.8. The svix library checks the signature on the exact raw body and refuses old timestamps.

const { campaignMessages, emailLinkClicks } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    tags?: Record<string, string> | { name: string; value: string }[];
    bounce?: { type?: string; subType?: string; message?: string };
    click?: { link?: string };
    failed?: { reason?: string };
  };
};

export function verifyResendSignature(rawBody: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, secret: string): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  try {
    new Webhook(secret).verify(rawBody, { 'svix-id': headers.id, 'svix-timestamp': headers.timestamp, 'svix-signature': headers.signature });
    return true;
  } catch {
    return false;
  }
}

function messageIdTag(tags: NonNullable<ResendEvent['data']>['tags']): string | null {
  const value = Array.isArray(tags) ? tags.find((t) => t.name === 'message_id')?.value : tags?.message_id;
  return value && UUID.test(value) ? value : null;
}

async function findMessage(tx: Tx, event: ResendEvent) {
  const resendId = event.data?.email_id;
  if (resendId) {
    const [row] = await tx.select().from(campaignMessages).where(eq(campaignMessages.resendId, resendId)).limit(1);
    if (row) return row;
  }
  const messageId = messageIdTag(event.data?.tags);
  if (!messageId) return null;
  const [row] = await tx.select().from(campaignMessages).where(eq(campaignMessages.id, messageId)).limit(1);
  return row ?? null;
}

const TIMESTAMP = {
  'email.sent': 'sentAt',
  'email.delivered': 'deliveredAt',
  'email.opened': 'openedAt',
  'email.clicked': 'clickedAt',
  'email.complained': 'complainedAt',
  'email.bounced': 'failedAt',
  'email.failed': 'failedAt',
  'email.suppressed': 'failedAt',
} as const;

/** Unmatched events, such as those from test emails, are stored by the caller and ignored here. */
export async function applyResendEvent(tx: Tx, event: ResendEvent, now = new Date()) {
  const row = await findMessage(tx, event);
  if (!row || row.channel !== 'email') return;
  const type = event.type ?? '';
  const result = reduceEmailStatus(row.status as EmailStatus, { type, bounce_type: event.data?.bounce?.type });
  if (result.unmatched) return;

  const at = event.created_at ? new Date(event.created_at) : now;
  const column = TIMESTAMP[type as keyof typeof TIMESTAMP];
  await tx
    .update(campaignMessages)
    .set({
      status: result.status,
      updatedAt: now,
      ...(column && !row[column] && { [column]: at }),
      ...(!row.resendId && event.data?.email_id && { resendId: event.data.email_id }),
      ...(type === 'email.bounced' && { bounceType: event.data?.bounce?.type ?? null, bounceSubtype: event.data?.bounce?.subType ?? null, errorDetail: event.data?.bounce?.message ?? null }),
      ...(type === 'email.failed' && { errorDetail: event.data?.failed?.reason ?? null }),
      ...(type === 'email.suppressed' && { errorCode: 'resend_suppressed' }),
    })
    .where(eq(campaignMessages.id, row.id));

  const link = event.data?.click?.link;
  if (type === 'email.clicked' && link) {
    await tx
      .insert(emailLinkClicks)
      .values({ campaignId: row.campaignId, url: link, clicks: 1 })
      .onConflictDoUpdate({ target: [emailLinkClicks.campaignId, emailLinkClicks.url], set: { clicks: sql`${emailLinkClicks.clicks} + 1` } });
  }

  if (result.suppress && row.emailTo) {
    await addSuppression(tx, { channel: 'email', identifier: row.emailTo, reason: result.suppress, source: row.campaignId, createdBy: 'system:webhook' });
    await writeAudit(tx, { id: 'system:webhook' }, 'email.webhook_suppressed', 'campaign_message', { entityId: row.id, channel: 'email', details: { reason: result.suppress } });
  }
}
