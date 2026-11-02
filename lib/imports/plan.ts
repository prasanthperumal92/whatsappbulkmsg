import { v7 as uuidv7 } from 'uuid';
import { ContactIndex, type StoreContact } from '@/lib/contacts/match';
import type { NormalisedRow } from './rows';

// §4.7 over a whole file. Validate and commit both call this, so commit re-matches against current data
// with exactly the rules the user saw (WP-03). Pure.

export type ImportSummary = {
  total: number;
  valid_new: number;
  valid_existing: number;
  email_only: number;
  email_only_unusable_phone: number;
  duplicates_in_file: number;
  suppressed: number;
  suppressed_emails: number;
  invalid: Record<string, number>;
  phone_warnings: Record<string, number>;
  email_warnings: { INVALID_EMAIL: number; role: number };
  ambiguous_email: number;
  invalid_time_zone: number;
  no_country: number;
  restricted_country: number;
  /** Rows that would be imported as opted in. Non-zero means the matching checkbox is required (§5.3). */
  would_opt_in: number;
  would_email_opt_in: number;
};

/** One contact the import creates or touches. Later rows that resolve to it are in-file duplicates. */
export type PlanEntry =
  | { kind: 'create'; contact_id: string; row: NormalisedRow; add_phone?: NormalisedRow }
  | { kind: 'match'; contact_id: string; row: NormalisedRow; add_phone?: NormalisedRow };

export type ImportPlan = { summary: ImportSummary; entries: PlanEntry[]; rejects: { index: number; reason: string }[] };

export type PlanContext = {
  contacts: StoreContact[];
  suppressedPhones: Set<string>;
  suppressedEmails: Set<string>;
  restrictedCountries: string[];
};

const bump = (counts: Record<string, number>, key: string) => void (counts[key] = (counts[key] ?? 0) + 1);

export function buildPlan(rows: NormalisedRow[], ctx: PlanContext): ImportPlan {
  const index = new ContactIndex(ctx.contacts);
  const restricted = new Set(ctx.restrictedCountries);
  const entries = new Map<string, PlanEntry>();
  const rejects: ImportPlan['rejects'] = [];
  const summary: ImportSummary = {
    total: rows.length, valid_new: 0, valid_existing: 0, email_only: 0, email_only_unusable_phone: 0, duplicates_in_file: 0,
    suppressed: 0, suppressed_emails: 0, invalid: {}, phone_warnings: {}, email_warnings: { INVALID_EMAIL: 0, role: 0 },
    ambiguous_email: 0, invalid_time_zone: 0, no_country: 0, restricted_country: 0, would_opt_in: 0, would_email_opt_in: 0,
  };

  for (const row of rows) {
    const result = index.match({ phone: row.phone, email: row.email, phone_reason: row.phone_reason });
    if (result.action === 'reject') {
      bump(summary.invalid, result.reason);
      rejects.push({ index: row.index, reason: result.reason });
      continue;
    }

    if (result.action === 'match') {
      const earlier = entries.get(result.contact_id);
      if (earlier) {
        // The first occurrence is kept. A phone it lacked isn't discarded, though: §4.7 still adds it.
        summary.duplicates_in_file++;
        if (result.add_phone) {
          earlier.add_phone = row;
          index.addPhone(result.contact_id, row.phone!, row.email!);
        }
        continue;
      }
      summary.valid_existing++;
      entries.set(result.contact_id, { kind: 'match', contact_id: result.contact_id, row, add_phone: result.add_phone ? row : undefined });
      if (result.add_phone) index.addPhone(result.contact_id, row.phone!, row.email!);
    } else {
      const contact_id = uuidv7();
      summary.valid_new++;
      entries.set(contact_id, { kind: 'create', contact_id, row });
      index.add({ id: contact_id, phone: row.phone, email: row.email });
      if (!row.phone) {
        summary.email_only++;
        if (row.phone_reason && row.phone_reason !== 'EMPTY_PHONE') summary.email_only_unusable_phone++;
      }
    }

    if (result.warning === 'AMBIGUOUS_EMAIL') summary.ambiguous_email++;
    if (row.phone_reason && row.phone_reason !== 'EMPTY_PHONE') bump(summary.phone_warnings, row.phone_reason);
    if (row.invalid_email) summary.email_warnings.INVALID_EMAIL++;
    if (row.role_email) summary.email_warnings.role++;
    if (row.invalid_time_zone) summary.invalid_time_zone++;
    if (!row.country) summary.no_country++;
    if (row.phone && row.country && restricted.has(row.country)) summary.restricted_country++;
    const phoneSuppressed = !!row.phone && ctx.suppressedPhones.has(row.phone);
    const emailSuppressed = !!row.email && ctx.suppressedEmails.has(row.email);
    if (phoneSuppressed) summary.suppressed++;
    if (emailSuppressed) summary.suppressed_emails++;
    if (row.phone && !phoneSuppressed && row.opt_in === 'opted_in') summary.would_opt_in++;
    if (row.email && !emailSuppressed && row.email_opt_in === 'opted_in') summary.would_email_opt_in++;
  }

  return { summary, entries: [...entries.values()], rejects };
}
