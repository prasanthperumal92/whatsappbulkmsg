import { desc, eq, sql } from 'drizzle-orm';
import { normaliseEmail } from '@/lib/contacts/email';
import { normalisePhone } from '@/lib/contacts/phone';
import { schema, type Tx } from '@/lib/db';
import type { Channel } from '@/lib/db/schema';

// §4.4: the one place that changes either suppression list. Contact statuses change in the same transaction.
// An opt-out with no matching contact is stored anyway and applies when that contact is imported later.

const { suppressionList, emailSuppressionList } = schema;

export const WHATSAPP_REASONS = ['stop_keyword', 'button', 'manual', 'error_131050'] as const;
export const EMAIL_REASONS = ['unsubscribe_link', 'one_click', 'hard_bounce', 'complaint', 'resend_suppressed', 'manual'] as const;

export type SuppressionInput = { channel: Channel; identifier: string; reason: string; source?: string | null; createdBy?: string | null };

/** Canonical form of a phone or address, or null if it isn't valid. */
export function normaliseIdentifier(channel: Channel, raw: string, defaultCountry = 'IN'): string | null {
  if (channel === 'email') return normaliseEmail(raw).email;
  const phone = normalisePhone(raw, { defaultCountry });
  return 'phone_e164' in phone ? phone.phone_e164 : null;
}

export async function addSuppression(tx: Tx, { channel, identifier, reason, source, createdBy }: SuppressionInput) {
  if (channel === 'email') {
    await tx.insert(emailSuppressionList).values({ email: identifier, reason, source, createdBy }).onConflictDoNothing();
    await tx.execute(sql`UPDATE contacts SET email_opt_in_status = 'opted_out', updated_at = now()
      WHERE email = ${identifier} AND email_opt_in_status <> 'opted_out'`);
  } else {
    await tx.insert(suppressionList).values({ phoneE164: identifier, reason, source, createdBy }).onConflictDoNothing();
    await tx.execute(sql`UPDATE contacts SET opt_in_status = 'opted_out', updated_at = now()
      WHERE phone_e164 = ${identifier} AND opt_in_status <> 'opted_out'`);
  }
}

/** Removal never restores consent: the status becomes `unknown` (§4.4). Returns false if it wasn't listed. */
export async function removeSuppression(tx: Tx, channel: Channel, identifier: string): Promise<boolean> {
  if (channel === 'email') {
    const removed = await tx.delete(emailSuppressionList).where(eq(emailSuppressionList.email, identifier)).returning();
    if (!removed.length) return false;
    await tx.execute(sql`UPDATE contacts SET email_opt_in_status = 'unknown', email_opt_in_source = NULL, email_opt_in_at = NULL, updated_at = now()
      WHERE email = ${identifier} AND email_opt_in_status = 'opted_out'`);
    return true;
  }
  const removed = await tx.delete(suppressionList).where(eq(suppressionList.phoneE164, identifier)).returning();
  if (!removed.length) return false;
  await tx.execute(sql`UPDATE contacts SET opt_in_status = 'unknown', opt_in_source = NULL, opt_in_at = NULL, updated_at = now()
    WHERE phone_e164 = ${identifier} AND opt_in_status = 'opted_out'`);
  return true;
}

export async function listSuppressions(tx: Tx, channel: Channel) {
  if (channel === 'email') {
    const rows = await tx.select().from(emailSuppressionList).orderBy(desc(emailSuppressionList.createdAt));
    return rows.map(({ email, ...rest }) => ({ identifier: email, ...rest }));
  }
  const rows = await tx.select().from(suppressionList).orderBy(desc(suppressionList.createdAt));
  return rows.map(({ phoneE164, ...rest }) => ({ identifier: phoneE164, ...rest }));
}

/** Both lists as sets, for bulk checks during an import. */
export async function loadSuppressionSets(tx: Tx) {
  // One after the other: a transaction has a single connection.
  const phones = await tx.select({ v: suppressionList.phoneE164 }).from(suppressionList);
  const emails = await tx.select({ v: emailSuppressionList.email }).from(emailSuppressionList);
  return { phones: new Set(phones.map((r) => r.v)), emails: new Set(emails.map((r) => r.v)) };
}

/** Puts both statuses back in step with the lists after a restore (§4.2). */
export async function reapplySuppressions(tx: Tx) {
  await tx.execute(sql`UPDATE contacts c SET opt_in_status = 'opted_out' FROM suppression_list s
    WHERE c.phone_e164 = s.phone_e164 AND c.opt_in_status <> 'opted_out'`);
  await tx.execute(sql`UPDATE contacts c SET email_opt_in_status = 'opted_out' FROM email_suppression_list s
    WHERE c.email = s.email AND c.email_opt_in_status <> 'opted_out'`);
}
