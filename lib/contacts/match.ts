// §4.7: decide what an import row does. Pure, so MA-* run with no database. The index is mutable because a
// file's earlier rows count as existing contacts for its later rows.

export type StoreContact = { id: string; phone: string | null; email: string | null; is_deleted?: boolean };
export type MatchRow = { phone: string | null; email: string | null; phone_reason?: string | null };
export type MatchResult =
  | { action: 'match'; contact_id: string; add_phone?: true; warning?: string }
  | { action: 'create'; email_only?: true; warning?: string }
  | { action: 'reject'; reason: string };

export class ContactIndex {
  private readonly byPhone = new Map<string, string>();
  private readonly emailOnly = new Map<string, string>();
  private readonly withPhone = new Map<string, string[]>();

  /** Contacts must arrive in contact_id order, so "earliest" is the first one seen. */
  constructor(contacts: Iterable<StoreContact> = []) {
    for (const c of contacts) if (!c.is_deleted) this.add(c);
  }

  add({ id, phone, email }: StoreContact) {
    if (phone) {
      this.byPhone.set(phone, id);
      if (email) this.withPhone.set(email, [...(this.withPhone.get(email) ?? []), id]);
    } else if (email) {
      this.emailOnly.set(email, id);
    }
  }

  /** An email-only contact has gained a phone. */
  addPhone(id: string, phone: string, email: string) {
    this.emailOnly.delete(email);
    this.add({ id, phone, email });
  }

  match(row: MatchRow): MatchResult {
    const warning = row.phone_reason && row.phone_reason !== 'EMPTY_PHONE' ? { warning: row.phone_reason } : {};
    if (row.phone) {
      const phoneMatch = this.byPhone.get(row.phone);
      if (phoneMatch) return { action: 'match', contact_id: phoneMatch };
      const emailOnly = row.email ? this.emailOnly.get(row.email) : undefined;
      if (emailOnly) return { action: 'match', contact_id: emailOnly, add_phone: true };
      return { action: 'create' };
    }
    if (row.email) {
      const emailOnly = this.emailOnly.get(row.email);
      if (emailOnly) return { action: 'match', contact_id: emailOnly, ...warning };
      const holders = this.withPhone.get(row.email) ?? [];
      if (holders.length > 1) return { action: 'match', contact_id: holders[0]!, warning: 'AMBIGUOUS_EMAIL' };
      if (holders.length === 1) return { action: 'match', contact_id: holders[0]!, ...warning };
      return { action: 'create', email_only: true, ...warning };
    }
    return { action: 'reject', reason: row.phone_reason ?? 'EMPTY_PHONE' };
  }
}

export const matchContact = (row: MatchRow, store: StoreContact[]) => new ContactIndex(store).match(row);
