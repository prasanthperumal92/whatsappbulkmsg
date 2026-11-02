import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, schema } from '@/lib/db';
import { parseBootstrapEmails, runMigrations } from '@/lib/db/migrate';
import { resetDb } from '../support/reset';

const db = getDb();
const { campaigns, campaignMessages, contacts, contactRevision } = schema;

/** drizzle wraps driver errors; the Postgres error and its constraint name are on `cause`. */
async function constraintViolated(run: PromiseLike<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    return (err as { cause?: { constraint?: string } }).cause?.constraint ?? 'no-constraint';
  }
  throw new Error('expected a constraint violation');
}

async function campaign(channel: 'whatsapp' | 'email', status = 'draft') {
  const [row] = await db.insert(campaigns).values({ channel, name: 'c', status }).returning();
  return row!;
}

const message = (campaignId: string, contactId: string, extra: Partial<typeof campaignMessages.$inferInsert> = {}) => ({
  campaignId,
  contactId,
  channel: 'email',
  ...extra,
});

const A = '01900000-0000-7000-8000-00000000000a';
const B = '01900000-0000-7000-8000-00000000000b';

beforeEach(resetDb);

describe('T1.4 schema', () => {
  it('migrates every §4.1 and §4.3 table', async () => {
    const { rows } = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    const names = rows.map((r) => r.table_name);
    for (const table of [
      'contacts', 'contact_revision', 'contact_snapshots', 'contact_import_changes', 'contact_erasures', 'import_batches',
      'mapping_presets', 'templates', 'campaigns', 'campaign_messages', 'contact_activity', 'suppression_list',
      'email_suppression_list', 'whatsapp_identities', 'email_link_clicks', 'rate_limits', 'webhook_events', 'settings',
      'audit_log', 'team_allowlist',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('seeds the contact_revision singleton and refuses a second row', async () => {
    const rows = await db.select().from(contactRevision);
    expect(rows).toMatchObject([{ id: 1, revision: 0 }]);
    expect(await constraintViolated(db.insert(contactRevision).values({ id: 2 }))).toBe('contact_revision_singleton');
  });

  it('UNIQUE(campaign_id, contact_id)', async () => {
    const c = await campaign('email');
    await db.insert(campaignMessages).values(message(c.id, A));
    expect(await constraintViolated(db.insert(campaignMessages).values(message(c.id, A)))).toBe('campaign_messages_campaign_contact');
  });

  it('partial UNIQUE(campaign_id, email_to) applies only when email_to is set', async () => {
    const c = await campaign('email');
    await db.insert(campaignMessages).values(message(c.id, A, { emailTo: 'a@example.com' }));
    expect(await constraintViolated(db.insert(campaignMessages).values(message(c.id, B, { emailTo: 'a@example.com' })))).toBe(
      'campaign_messages_campaign_email',
    );
    await db.insert(campaignMessages).values(message(c.id, B, { emailTo: null }));
    const other = await campaign('email');
    await db.insert(campaignMessages).values(message(other.id, A, { emailTo: 'a@example.com' }));
  });

  it('allows one running campaign per channel', async () => {
    await campaign('whatsapp', 'running');
    expect(await constraintViolated(db.insert(campaigns).values({ channel: 'whatsapp', name: 'x', status: 'running' }))).toBe(
      'campaigns_one_running_per_channel',
    );
    await campaign('email', 'running');
    await campaign('whatsapp', 'queued');
    const done = await campaign('whatsapp', 'paused');
    expect(await constraintViolated(db.update(campaigns).set({ status: 'running' }).where(eq(campaigns.id, done.id)))).toBe(
      'campaigns_one_running_per_channel',
    );
  });

  it('contacts need a phone or email', async () => {
    expect(await constraintViolated(db.insert(contacts).values({ firstName: 'x' }))).toBe('contacts_has_identifier');
  });

  it('phones are unique among non-deleted contacts', async () => {
    const [first] = await db.insert(contacts).values({ phoneE164: '+919876543210' }).returning();
    expect(await constraintViolated(db.insert(contacts).values({ phoneE164: '+919876543210' }))).toBe('contacts_phone_unique');
    await db.update(contacts).set({ isDeleted: true }).where(eq(contacts.contactId, first!.contactId));
    await db.insert(contacts).values({ phoneE164: '+919876543210' });
  });

  it('emails are unique only among contacts with no phone', async () => {
    await db.insert(contacts).values({ email: 'a@example.com' });
    expect(await constraintViolated(db.insert(contacts).values({ email: 'a@example.com' }))).toBe('contacts_email_only_unique');
    await db.insert(contacts).values({ phoneE164: '+919876543211', email: 'a@example.com' });
    await db.insert(contacts).values({ phoneE164: '+919876543212', email: 'a@example.com' });
  });

  it('an email-only contact cannot be opted in to WhatsApp', async () => {
    expect(await constraintViolated(db.insert(contacts).values({ email: 'a@example.com', optInStatus: 'opted_in' }))).toBe(
      'contacts_no_phone_no_opt_in',
    );
  });

  it('generates UUIDv7 contact ids', async () => {
    const [row] = await db.insert(contacts).values({ email: 'v7@example.com' }).returning();
    expect(row!.contactId[14]).toBe('7');
  });
});

describe('deploy-time migrations', () => {
  const url = () => process.env.DATABASE_URL!;

  it('applying them again changes nothing', async () => {
    await db.insert(contacts).values({ email: 'keep@example.com' });
    await runMigrations(url());
    expect(await db.select().from(contacts)).toHaveLength(1);
  });

  it('seeds bootstrap emails only while the allowlist is empty', async () => {
    await runMigrations(url(), parseBootstrapEmails(' First@Example.com, first@example.com ,second@example.com'));
    const seeded = await db.select().from(schema.teamAllowlist);
    expect(seeded.map((r) => r.email).sort()).toEqual(['first@example.com', 'second@example.com']);
    await runMigrations(url(), ['third@example.com']);
    expect(await db.select().from(schema.teamAllowlist)).toHaveLength(2);
  });
});
