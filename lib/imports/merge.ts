import type { ContactRow } from '@/lib/contacts/store';
import { TEXT_FIELDS, type ConsentValue, type NormalisedRow } from './rows';

// §4.4, §4.7 and §5.3: the contact a row produces. Pure, so each policy can be read and tested on its own.

export type ExistingPolicy = 'skip' | 'fill_empty' | 'overwrite';
export type MergeContext = {
  /** Null for a contact added by hand. */
  batchId: string | null;
  source: string;
  now: string;
  userId: string;
  suppressedPhones: Set<string>;
  suppressedEmails: Set<string>;
};

/** A consent status for an identifier this contact didn't hold before. Suppression always wins. */
function freshConsent(incoming: ConsentValue, hasIdentifier: boolean, suppressed: boolean, { source, now }: MergeContext) {
  if (suppressed) return { status: 'opted_out', source: null, at: null };
  if (!hasIdentifier && incoming === 'opted_in') return { status: 'unknown', source: null, at: null };
  if (incoming === 'unknown') return { status: 'unknown', source: null, at: null };
  return { status: incoming as string, source, at: now };
}

export function newContact(contact_id: string, row: NormalisedRow, ctx: MergeContext): ContactRow {
  const whatsapp = freshConsent(row.opt_in, !!row.phone, !!row.phone && ctx.suppressedPhones.has(row.phone), ctx);
  const email = freshConsent(row.email_opt_in, !!row.email, !!row.email && ctx.suppressedEmails.has(row.email), ctx);
  return {
    contact_id,
    phone_e164: row.phone,
    wa_to: row.wa_to,
    country_iso: row.country,
    time_zone: row.time_zone,
    first_name: row.fields.first_name ?? null,
    last_name: row.fields.last_name ?? null,
    display_name: row.fields.display_name ?? null,
    email: row.email,
    company: row.fields.company ?? null,
    city: row.fields.city ?? null,
    language: row.fields.language ?? null,
    tags: row.tags,
    attributes: row.attributes,
    opt_in_status: whatsapp.status,
    opt_in_source: whatsapp.source,
    opt_in_at: whatsapp.at,
    email_opt_in_status: email.status,
    email_opt_in_source: email.source,
    email_opt_in_at: email.at,
    consent_proof_ref: row.fields.consent_proof_ref ?? null,
    import_batch_id: ctx.batchId,
    created_by: ctx.userId,
    updated_by: ctx.userId,
    created_at: ctx.now,
    updated_at: ctx.now,
    is_deleted: false,
    deleted_at: null,
  };
}

/**
 * The next consent status for an identifier the contact already holds. An opt-out is permanent here, and
 * `unknown` in a file says nothing, so it never lowers an existing opt-in (G-15).
 */
function nextConsent(current: { status: string; source: string | null; at: string | null }, incoming: ConsentValue, policy: ExistingPolicy, suppressed: boolean, ctx: MergeContext) {
  if (suppressed || current.status === 'opted_out') return current.status === 'opted_out' ? current : { status: 'opted_out', source: current.source, at: current.at };
  if (policy === 'skip' || incoming === 'unknown' || incoming === current.status) return current;
  if (incoming === 'opted_in' && current.status === 'unknown') return { status: 'opted_in', source: ctx.source, at: ctx.now };
  if (incoming === 'opted_out' && (current.status === 'unknown' || policy === 'overwrite')) return { status: 'opted_out', source: ctx.source, at: ctx.now };
  return current;
}

/** Returns the merged contact, or null if the row changes nothing, so a re-import touches no rows. */
export function mergeContact(existing: ContactRow, row: NormalisedRow, addPhone: NormalisedRow | undefined, policy: ExistingPolicy, ctx: MergeContext): ContactRow | null {
  const next: ContactRow = { ...existing, tags: [...new Set([...existing.tags, ...row.tags])], attributes: { ...existing.attributes } };

  if (policy !== 'skip') {
    const take = policy === 'overwrite' ? (_old: unknown, value: unknown) => value !== undefined : (old: unknown, value: unknown) => value !== undefined && (old === null || old === undefined || old === '');
    for (const field of TEXT_FIELDS) {
      if (take(next[field], row.fields[field])) next[field] = row.fields[field]!;
    }
    for (const [key, value] of Object.entries(row.attributes)) {
      if (take(next.attributes[key], value)) next.attributes[key] = value;
    }
    if (policy === 'fill_empty') {
      next.country_iso ??= row.country;
      next.time_zone ??= row.time_zone;
    } else {
      if (row.country_mapped) next.country_iso = row.country;
      if (row.zone_mapped || row.country_mapped) next.time_zone = row.time_zone;
      next.country_iso ??= row.country;
      next.time_zone ??= row.time_zone;
    }
  }

  const emailChanges = policy !== 'skip' && !!row.email && row.email !== existing.email && (policy === 'overwrite' || !existing.email);
  if (emailChanges) next.email = row.email;

  // §4.7 adds the phone under every policy: it is identity, not one of the mapped fields a policy governs.
  if (addPhone) {
    next.phone_e164 = addPhone.phone;
    next.wa_to = addPhone.wa_to;
    next.country_iso ??= addPhone.country;
    next.time_zone ??= addPhone.time_zone;
  }

  // Consent follows the identifier (§4.7): a new one starts from this row, a held one merges.
  const phoneSuppressed = !!next.phone_e164 && ctx.suppressedPhones.has(next.phone_e164);
  const whatsapp = addPhone
    ? freshConsent(addPhone.opt_in, true, phoneSuppressed, ctx)
    : nextConsent({ status: existing.opt_in_status, source: existing.opt_in_source, at: existing.opt_in_at }, row.phone ? row.opt_in : 'unknown', policy, phoneSuppressed, ctx);
  next.opt_in_status = whatsapp.status;
  next.opt_in_source = whatsapp.source;
  next.opt_in_at = whatsapp.at;

  const emailSuppressed = !!next.email && ctx.suppressedEmails.has(next.email);
  const email = emailChanges
    ? freshConsent(row.email_opt_in, true, emailSuppressed, ctx)
    : nextConsent({ status: existing.email_opt_in_status, source: existing.email_opt_in_source, at: existing.email_opt_in_at }, row.email && row.email === next.email ? row.email_opt_in : 'unknown', policy, emailSuppressed, ctx);
  next.email_opt_in_status = email.status;
  next.email_opt_in_source = email.source;
  next.email_opt_in_at = email.at;

  if (JSON.stringify(next) === JSON.stringify(existing)) return null;
  return { ...next, import_batch_id: ctx.batchId, updated_by: ctx.userId, updated_at: ctx.now };
}
