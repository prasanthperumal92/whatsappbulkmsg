import { sql } from 'drizzle-orm';
import { schema, type Tx } from '@/lib/db';

// §4.1 and §4.2: Postgres access for contacts. Bulk writes send one JSON document per chunk, so a 50k-row
// import stays well inside the bind-parameter limit and the row data never appears in query text.

const COLUMN_TYPES = {
  contact_id: 'uuid', phone_e164: 'varchar', wa_to: 'varchar', country_iso: 'varchar', time_zone: 'varchar', first_name: 'varchar',
  last_name: 'varchar', display_name: 'varchar', email: 'varchar', company: 'varchar', city: 'varchar', language: 'varchar',
  tags: 'text[]', attributes: 'jsonb', opt_in_status: 'varchar', opt_in_source: 'varchar', opt_in_at: 'timestamptz',
  email_opt_in_status: 'varchar', email_opt_in_source: 'varchar', email_opt_in_at: 'timestamptz', consent_proof_ref: 'varchar',
  import_batch_id: 'varchar', created_by: 'varchar', updated_by: 'varchar', created_at: 'timestamptz', updated_at: 'timestamptz',
  is_deleted: 'boolean', deleted_at: 'timestamptz',
} as const;

export type ContactColumn = keyof typeof COLUMN_TYPES;
export const CONTACT_COLUMNS = Object.keys(COLUMN_TYPES) as ContactColumn[];

/** One contact, using its column names, with timestamps as ISO strings so it survives a JSON round trip. */
export type ContactRow = {
  contact_id: string;
  phone_e164: string | null;
  wa_to: string | null;
  country_iso: string | null;
  time_zone: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  company: string | null;
  city: string | null;
  language: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  opt_in_status: string;
  opt_in_source: string | null;
  opt_in_at: string | null;
  email_opt_in_status: string;
  email_opt_in_source: string | null;
  email_opt_in_at: string | null;
  consent_proof_ref: string | null;
  import_batch_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  is_deleted: boolean;
  deleted_at: string | null;
};

const CHUNK = 2000;
const RECORD_DEF = sql.raw(CONTACT_COLUMNS.map((c) => `"${c}" ${COLUMN_TYPES[c]}`).join(', '));
const COLUMN_LIST = sql.raw(CONTACT_COLUMNS.map((c) => `"${c}"`).join(', '));

function fromDb(row: Record<string, unknown>): ContactRow {
  const out = { ...row } as Record<string, unknown>;
  for (const key of ['opt_in_at', 'email_opt_in_at', 'created_at', 'updated_at', 'deleted_at']) {
    if (out[key] instanceof Date) out[key] = (out[key] as Date).toISOString();
  }
  return out as ContactRow;
}

/** §5.4 search: name, phone or email, contains. */
function liveMatching(q: string) {
  const term = q.trim();
  if (!term) return sql`is_deleted = false`;
  const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
  return sql`is_deleted = false AND (first_name ILIKE ${like} OR last_name ILIKE ${like} OR display_name ILIKE ${like} OR concat_ws(' ', first_name, last_name) ILIKE ${like} OR phone_e164 ILIKE ${like} OR email ILIKE ${like})`;
}

export const IMPORT_LOCK = 727_001;

export class ContactStore {
  constructor(private readonly tx: Tx) {}

  /** Serialises imports, undos and restores (§4.2). Released when the transaction ends. */
  async lockForImport() {
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK})`);
  }

  async revision(): Promise<number> {
    const { rows } = await this.tx.execute<{ revision: string }>(sql`SELECT revision FROM contact_revision WHERE id = 1`);
    return Number(rows[0]?.revision ?? 0);
  }

  /**
   * Call once per user-initiated data change (§4.2). Any change ends the ability to undo earlier imports, so
   * their change logs are deleted here (§4.3).
   */
  async bumpRevision(): Promise<number> {
    const { rows } = await this.tx.execute<{ revision: string }>(
      sql`UPDATE contact_revision SET revision = revision + 1, updated_at = now() WHERE id = 1 RETURNING revision`,
    );
    await this.tx.delete(schema.contactImportChanges);
    return Number(rows[0]!.revision);
  }

  /** The identifiers of all non-deleted contacts, in contact_id order, as `ContactIndex` needs them. */
  async identities() {
    const { rows } = await this.tx.execute<{ id: string; phone: string | null; email: string | null }>(
      sql`SELECT contact_id AS id, phone_e164 AS phone, email FROM contacts WHERE is_deleted = false ORDER BY contact_id`,
    );
    return rows;
  }

  /** `identities()` narrowed to the contacts one row can match, for a single write. */
  async identitiesMatching(phone: string | null, email: string | null) {
    const { rows } = await this.tx.execute<{ id: string; phone: string | null; email: string | null }>(
      sql`SELECT contact_id AS id, phone_e164 AS phone, email FROM contacts WHERE is_deleted = false AND (phone_e164 = ${phone} OR email = ${email}) ORDER BY contact_id`,
    );
    return rows;
  }

  async getMany(ids: string[]): Promise<ContactRow[]> {
    const out: ContactRow[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { rows } = await this.tx.execute(
        sql`SELECT ${COLUMN_LIST} FROM contacts WHERE contact_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids.slice(i, i + CHUNK))}::jsonb))`,
      );
      out.push(...rows.map(fromDb));
    }
    return out;
  }

  /** Non-deleted contacts, in contact_id order. */
  async listLive(): Promise<ContactRow[]> {
    const { rows } = await this.tx.execute(sql`SELECT ${COLUMN_LIST} FROM contacts WHERE is_deleted = false ORDER BY contact_id`);
    return rows.map(fromDb);
  }

  async count(): Promise<number> {
    const { rows } = await this.tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts WHERE is_deleted = false`);
    return rows[0]!.n;
  }

  /** One page of live contacts, newest first, for the S-03 grid. */
  async listPage({ q, page, pageSize }: { q: string; page: number; pageSize: number }): Promise<{ items: (ContactRow & { last_email_at: string | null })[]; total: number }> {
    const where = liveMatching(q);
    const { rows: counted } = await this.tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts WHERE ${where}`);
    const { rows } = await this.tx.execute(sql`SELECT ${COLUMN_LIST} FROM contacts WHERE ${where} ORDER BY contact_id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    const items = rows.map(fromDb);
    const { rows: activity } = await this.tx.execute<{ contact_id: string; last_email_at: Date | string | null }>(
      sql`SELECT contact_id, last_email_at FROM contact_activity WHERE contact_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(items.map((c) => c.contact_id))}::jsonb))`,
    );
    const lastEmail = new Map(activity.map((a) => [a.contact_id, a.last_email_at ? new Date(a.last_email_at).toISOString() : null]));
    return { items: items.map((c) => ({ ...c, last_email_at: lastEmail.get(c.contact_id) ?? null })), total: counted[0]!.n };
  }

  /** Every live contact the search matches, for a selection made with "select all matching". */
  async listMatching(q: string): Promise<ContactRow[]> {
    const { rows } = await this.tx.execute(sql`SELECT ${COLUMN_LIST} FROM contacts WHERE ${liveMatching(q)} ORDER BY contact_id`);
    return rows.map(fromDb);
  }

  async insertMany(contacts: Partial<ContactRow>[]) {
    for (let i = 0; i < contacts.length; i += CHUNK) {
      const json = JSON.stringify(contacts.slice(i, i + CHUNK));
      await this.tx.execute(sql`
        INSERT INTO contacts (${COLUMN_LIST})
        SELECT r.contact_id, r.phone_e164, r.wa_to, r.country_iso, r.time_zone, r.first_name, r.last_name, r.display_name, r.email,
               r.company, r.city, COALESCE(r.language, 'en'), COALESCE(r.tags, '{}'), COALESCE(r.attributes, '{}'),
               COALESCE(r.opt_in_status, 'unknown'), r.opt_in_source, r.opt_in_at,
               COALESCE(r.email_opt_in_status, 'unknown'), r.email_opt_in_source, r.email_opt_in_at, r.consent_proof_ref,
               r.import_batch_id, r.created_by, r.updated_by, COALESCE(r.created_at, now()), COALESCE(r.updated_at, now()),
               COALESCE(r.is_deleted, false), r.deleted_at
        FROM jsonb_to_recordset(${json}::jsonb) AS r(${RECORD_DEF})`);
    }
  }

  /** Writes every column of each row. `created_at` is left alone. */
  async updateMany(contacts: ContactRow[]) {
    const assign = sql.raw(
      CONTACT_COLUMNS.filter((c) => c !== 'contact_id' && c !== 'created_at' && c !== 'updated_at')
        .map((c) => `"${c}" = r."${c}"`)
        .join(', '),
    );
    for (let i = 0; i < contacts.length; i += CHUNK) {
      const json = JSON.stringify(contacts.slice(i, i + CHUNK));
      await this.tx.execute(sql`
        UPDATE contacts c SET ${assign}, updated_at = COALESCE(r.updated_at, now())
        FROM jsonb_to_recordset(${json}::jsonb) AS r(${RECORD_DEF})
        WHERE c.contact_id = r.contact_id`);
    }
  }

  async hardDelete(ids: string[]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      await this.tx.execute(sql`DELETE FROM contacts WHERE contact_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids.slice(i, i + CHUNK))}::jsonb))`);
    }
  }
}
