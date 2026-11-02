import { eq, sql } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import golden from '../../evals/golden/import-summaries.json';
import * as activeRoute from '@/app/api/imports/active/route';
import * as importRoute from '@/app/api/imports/[id]/route';
import * as uploadTokenRoute from '@/app/api/imports/upload-token/route';
import * as presetsRoute from '@/app/api/mapping-presets/route';
import * as suppressionRoute from '@/app/api/suppression/route';
import { ContactStore } from '@/lib/contacts/store';
import { getDb, schema } from '@/lib/db';
import { addSuppression } from '@/lib/suppression/service';
import { signInAs, resetClerk } from '../support/clerk-mock';
import { analyze, commit, fixture, prepare, rejects, runImport, undo, upload, validate } from '../support/imports';
import { resetDb } from '../support/reset';

const db = getDb();
const { contacts, contactImportChanges, importBatches, auditLog, suppressionList, emailSuppressionList, teamAllowlist } = schema;
const ME = 'asha.member@example.com';
const none = { params: Promise.resolve({}) };

beforeEach(async () => {
  await resetDb();
  resetClerk();
  await db.insert(teamAllowlist).values({ email: ME });
  signInAs(ME, 'user_asha');
});

const revision = () => new ContactStore(db).revision();
const liveCount = () => new ContactStore(db).count();
const byPhone = async (phone: string) => (await db.select().from(contacts).where(eq(contacts.phoneE164, phone)))[0];
const byEmail = async (email: string) => (await db.select().from(contacts).where(eq(contacts.email, email)))[0];

type Case = Record<string, any>;
const cases = golden.cases as unknown as Case[];
const get = (id: string) => cases.find((c) => c.id === id)!;

/** Translates the golden's option names to the API's. */
function apiOptions(c: Case) {
  const o = c.options ?? {};
  const parse = { ...(o.header_row !== undefined && { header_row: o.header_row }), ...(o.rows_to_skip !== undefined && { rows_to_skip: o.rows_to_skip }) };
  return {
    parse,
    options: {
      ...(o.tag_separator && { tag_separator: o.tag_separator }),
      ...(o.opt_in_value_for_file && { opt_in_value: o.opt_in_value_for_file }),
      ...(o.email_opt_in_value_for_file && { email_opt_in_value: o.email_opt_in_value_for_file }),
    },
    commit: { consent_confirmed: !!o.consent_confirmed, email_consent_confirmed: !!o.email_consent_confirmed },
  };
}

const COLUMN_NAMES: Record<string, keyof typeof contacts.$inferSelect> = {
  phone_e164: 'phoneE164', wa_to: 'waTo', email: 'email', first_name: 'firstName', company: 'company', tags: 'tags', country_iso: 'countryIso',
  time_zone: 'timeZone', opt_in_status: 'optInStatus',
};

async function expectRows(rows: Record<string, unknown>[]) {
  for (const want of rows) {
    const found = want.phone_e164 ? await byPhone(want.phone_e164 as string) : await byEmail(want.email as string);
    expect(found, JSON.stringify(want)).toBeDefined();
    for (const [key, column] of Object.entries(COLUMN_NAMES)) {
      if (key in want) expect(found![column], `${key} of ${JSON.stringify(want)}`).toEqual(want[key]);
    }
  }
}

function expectSummary(summary: Record<string, any>, want: Record<string, any> = {}) {
  const { suppressed_emails, ...rest } = want;
  expect(summary).toMatchObject(rest);
  if (suppressed_emails !== undefined) expect(summary.suppressed_emails).toBe(suppressed_emails);
}

describe('IS-01…18 import summaries', () => {
  it('IS-01 basic.csv', async () => {
    const c = get('IS-01');
    const { analysis, summary, import_id, result } = await runImport(fixture(c.fixture), { options: { tag_separator: ';' } });
    expect(analysis.detect).toMatchObject(c.detect);
    expect(analysis.auto_mapping).toEqual(c.auto_mapping);
    expectSummary(summary, c.validate);
    expect(result.new_rows).toBe(c.commit.new_rows);
    await expectRows(c.commit.rows);

    const link = await (await rejects(import_id)).json();
    expect(link.url).toContain('download=1');
    const text = await (await rejects(import_id, '?download=1')).text();
    const lines = text.trim().split(/\r?\n/);
    expect(lines).toHaveLength(c.rejects_csv.rows + 1);
    expect(lines[0]).toBe('Mobile No,Name,Segment,Notes,reject_reason'); // FR-IMP-07, keeps the original columns
    expect(lines.slice(1).map((l) => l.split(',').at(-1)).sort()).toEqual(['EMPTY_PHONE', 'INVALID_PHONE', 'SCIENTIFIC_NOTATION']);
  });

  it('IS-02 FR-IMP-06 re-importing the same file creates 0 new rows and warns', async () => {
    const c = get('IS-02');
    const first = await runImport(fixture(c.fixture), { name: 'basic.csv' });
    const before = await liveCount();
    const { summary, duplicate_of, result } = await runImport(fixture(c.fixture), { name: 'basic.csv' });
    expect(duplicate_of?.import_id).toBe(first.import_id);
    expect(duplicate_of?.message).toContain(c.register.message_contains);
    expect(duplicate_of?.message).toContain(ME);
    expectSummary(summary, c.validate);
    expect(result.new_rows).toBe(0);
    expect(await liveCount()).toBe(before);
  });

  it('IS-03 FR-IMP-02 semicolons and Windows-1252, with no mojibake', async () => {
    const c = get('IS-03');
    const { analysis, summary } = await prepare(fixture(c.fixture));
    expect(analysis.detect).toMatchObject(c.detect);
    expect(analysis.preview_headers).toEqual(c.preview_headers);
    expect(analysis.preview_rows).toEqual(c.preview_rows);
    expectSummary(summary, c.validate);
  });

  it('IS-04 BOM stripped, and an invalid email does not reject the row', async () => {
    const c = get('IS-04');
    const { analysis, summary } = await runImport(fixture(c.fixture));
    expect(analysis.detect).toMatchObject(c.detect);
    expect(analysis.auto_mapping).toEqual(c.auto_mapping);
    expectSummary(summary, c.validate);
    expect(summary.email_warnings.INVALID_EMAIL).toBe(1);
    await expectRows(c.commit.rows);
  });

  it.each(['IS-05', 'IS-07'])('%s detection and auto-mapping', async (id) => {
    const c = get(id);
    const { analysis, summary } = await prepare(fixture(c.fixture));
    expect(analysis.detect).toMatchObject(c.detect);
    expect(analysis.auto_mapping).toEqual(c.auto_mapping);
    expectSummary(summary, c.validate);
  });

  it('IS-06 embedded newlines do not create rows', async () => {
    const c = get('IS-06');
    const { summary } = await runImport(fixture(c.fixture));
    expectSummary(summary, c.validate);
    await expectRows(c.commit.rows);
  });

  it('IS-08 opt-in column values, and consent is required', async () => {
    const c = get('IS-08');
    const { import_id } = await prepare(fixture(c.fixture));
    const refused = await commit(import_id, {});
    expect(refused.status).toBe(422);
    expect(await liveCount()).toBe(0);
    expect((await importRoute.GET(new Request('http://x'), { params: Promise.resolve({ id: import_id }) }).then((r) => r.json())).status).toBe('validated');

    const ok = await commit(import_id, { consent_confirmed: true });
    expect(ok.status).toBe(200);
    for (const [phone, status] of Object.entries(c.commit.opt_in_status_by_phone)) {
      expect((await byPhone(phone))?.optInStatus, phone).toBe(status);
    }
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, import_id));
    expect(batch!.consentJson).toMatchObject({ whatsapp: { confirmed_by: ME } });
    expect((batch!.consentJson as Record<string, unknown>).email).toBeUndefined();
    expect((await byPhone('+919876543210'))?.optInSource).toMatch(/^csv:/);
    expect((await byPhone('+919876543210'))?.optInAt).toBeInstanceOf(Date);
  });

  it('IS-09 formula payloads are stored unchanged', async () => {
    const c = get('IS-09');
    const { summary } = await runImport(fixture(c.fixture));
    expectSummary(summary, c.validate);
    expect((await byPhone('+919876543210'))).toMatchObject({ firstName: '=SUM(1+1)', company: '@evil' });
  });

  describe('IS-10 existing-contact policies', () => {
    const c = get('IS-10');
    it.each(['fill_empty', 'overwrite', 'skip'])('%s', async (policy) => {
      await runImport(fixture('basic.csv'));
      const { summary } = await runImport(fixture(c.fixture), { commit: { policy } });
      expectSummary(summary, c.validate);
      for (const [phone, want] of Object.entries(c.by_policy[policy] as Record<string, any>)) {
        const got = await byPhone(phone);
        expect({ first_name: got?.firstName, company: got?.company, tags: got?.tags }, `${policy} ${phone}`).toEqual(want);
      }
    });
  });

  it('IS-11 too many columns', async () => {
    const c = get('IS-11');
    const { import_id } = await upload(fixture(c.fixture));
    const res = await analyze(import_id);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain(c.analyze.reason_contains);
  });

  it('IS-12 no header row', async () => {
    const c = get('IS-12');
    const { analysis, summary } = await prepare(fixture(c.fixture), { mapping: { 0: 'phone', 1: 'first_name' } });
    expect(analysis.detect.header_row).toBe(false);
    expect(analysis.preview_headers).toEqual(['Col A', 'Col B']);
    expectSummary(summary, c.validate);
    const forced = await prepare(fixture(c.fixture), { parse: { header_row: true }, mapping: { 0: 'phone', 1: 'first_name' } });
    expect(forced.summary.total).toBe(1);
  });

  it('IS-13 rows to skip: detected, and as an override', async () => {
    const c = get('IS-13');
    const auto = await prepare(fixture(c.fixture));
    expect(auto.analysis.detect.rows_to_skip).toBe(2);
    expectSummary(auto.summary, c.validate);
    const manual = await prepare(fixture(c.fixture), { parse: { rows_to_skip: 2 } });
    expectSummary(manual.summary, c.validate);
  });

  it('IS-15 FR-IMP-10 a suppressed number stays opted out', async () => {
    const c = get('IS-15');
    await db.insert(suppressionList).values({ phoneE164: '+919845012345', reason: 'stop_keyword' });
    const { summary } = await runImport(fixture(c.fixture), { options: apiOptions(c).options, commit: apiOptions(c).commit });
    expectSummary(summary, c.validate);
    for (const [phone, status] of Object.entries(c.commit.opt_in_status_by_phone)) expect((await byPhone(phone))?.optInStatus).toBe(status);
  });

  it('IS-16 FR-IMP-04 email-only contacts', async () => {
    const c = get('IS-16');
    const { analysis, summary, import_id, result } = await runImport(fixture(c.fixture));
    expect(analysis.auto_mapping).toEqual(c.auto_mapping);
    expectSummary(summary, c.validate);
    expect(summary.email_only_unusable_phone).toBe(2);
    expect(result.new_rows).toBe(c.commit.new_rows);
    await expectRows(c.commit.rows);
    const text = await (await rejects(import_id, '?download=1')).text();
    expect(text.trim().split(/\r?\n/)).toHaveLength(c.rejects_csv.rows + 1);
    expect(text).toContain(c.rejects_csv.has_column);
  });

  it('IS-17 overseas, mapped country and time zone', async () => {
    const c = get('IS-17');
    const { analysis, summary } = await runImport(fixture(c.fixture));
    expect(analysis.auto_mapping).toEqual(c.auto_mapping);
    expectSummary(summary, c.validate);
    await expectRows(c.commit.rows);
  });

  it('IS-18 a suppressed address stays opted out', async () => {
    const c = get('IS-18');
    await db.insert(emailSuppressionList).values({ email: 'hans@example.de', reason: 'complaint' });
    const { summary } = await runImport(fixture(c.fixture), { options: apiOptions(c).options, commit: apiOptions(c).commit });
    expectSummary(summary, c.validate);
    for (const [email, status] of Object.entries(c.commit.email_opt_in_status_by_email)) expect((await byEmail(email))?.emailOptInStatus).toBe(status);
  });

  it('IS-14 NFR-01 50k rows: validate + commit under 60 s (local Postgres, not a deployment)', async () => {
    const c = get('IS-14');
    // Git-ignored because of its size, so a fresh clone has to generate it.
    if (!existsSync('evals/fixtures/large-50k.csv')) execFileSync('node', ['evals/fixtures/generate.mjs', '--large']);
    const bytes = readFileSync('evals/fixtures/large-50k.csv');
    const { import_id } = await upload(bytes);
    const { suggestions } = await (await analyze(import_id)).json();
    const started = performance.now();
    const res = await validate(import_id, { mapping: suggestions, options: { tag_separator: ';' } });
    const summary = await res.json();
    expectSummary(summary, c.validate);
    const done = await commit(import_id, { consent_confirmed: true });
    const elapsed = performance.now() - started;
    expect(done.status).toBe(200);
    expect((await done.json()).new_rows).toBe(c.commit.new_rows);
    expect(await liveCount()).toBe(50_000);
    console.log(`NFR-01: validate + commit took ${(elapsed / 1000).toFixed(1)} s`);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});

describe('WP commit and undo', () => {
  const csv = (...rows: string[]) => `phone,name\n${rows.join('\n')}\n`;

  it('WP-01 two simultaneous commits both land, one after the other', async () => {
    const a = await prepare(csv('9876543210,A'));
    const b = await prepare(csv('9812345678,B'));
    const start = await revision();
    const [ra, rb] = await Promise.all([commit(a.import_id), commit(b.import_id)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await revision()).toBe(start + 2);
    expect(await liveCount()).toBe(2);
  });

  it('WP-02 FR-IMP-11 a commit waits for the lock and then succeeds, and the UI can see who holds it', async () => {
    const a = await prepare(csv('9876543210,A'));
    const release: { fn?: () => void } = {};
    const held = new Promise<void>((resolve) => (release.fn = resolve));
    let waiting!: Promise<Response>;
    await db.transaction(async (tx) => {
      await new ContactStore(tx).lockForImport();
      waiting = commit(a.import_id);
      await expect.poll(async () => (await (await activeRoute.GET(new Request('http://x/api/imports/active'), none)).json()).active?.by).toBe(ME);
      expect(await liveCount()).toBe(0);
      release.fn!();
      await held;
    });
    expect((await waiting).status).toBe(200);
    expect(await liveCount()).toBe(1);
    expect((await (await activeRoute.GET(new Request('http://x/api/imports/active'), none)).json()).active).toBeNull();
  });

  it('a double-submitted commit applies once', async () => {
    const a = await prepare(csv('9876543210,A'));
    const start = await revision();
    const statuses = (await Promise.all([commit(a.import_id), commit(a.import_id)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await revision()).toBe(start + 1);
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, a.import_id));
    expect(batch!.status).toBe('committed'); // The losing request must not mark it failed.
  });

  it('WP-03 commit re-matches against current data', async () => {
    const p = await prepare(csv('9876543210,FromFile', '9812345678,New'));
    expect(p.summary.valid_new).toBe(2);
    await db.insert(contacts).values({ phoneE164: '+919876543210', firstName: 'AddedLater' });
    const res = await commit(p.import_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ new_rows: 1 });
    expect(await liveCount()).toBe(2);
    expect((await byPhone('+919876543210'))?.firstName).toBe('AddedLater');
  });

  it('WP-04 a failure after the merge leaves nothing behind, and the batch is failed', async () => {
    const p = await prepare(csv('9876543210,A'));
    const start = await revision();
    // A real database error at the last step of the transaction, after contacts and the change log are written.
    await db.execute(sql`CREATE FUNCTION fail_commit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER fail_commit BEFORE UPDATE ON import_batches FOR EACH ROW WHEN (NEW.status = 'committed') EXECUTE FUNCTION fail_commit()`);
    try {
      const res = await commit(p.import_id);
      expect(res.status).toBe(500);
      expect(await liveCount()).toBe(0);
      expect(await db.select().from(contactImportChanges)).toEqual([]);
      expect(await revision()).toBe(start);
      const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, p.import_id));
      expect(batch).toMatchObject({ status: 'failed', commitStartedAt: null });
      expect((await db.select().from(auditLog).where(eq(auditLog.action, 'import.commit')))).toEqual([]);
    } finally {
      await db.execute(sql`DROP TRIGGER fail_commit ON import_batches`);
      await db.execute(sql`DROP FUNCTION fail_commit`);
    }
    expect((await commit(p.import_id)).status).toBe(200); // It can be retried.
  });

  it('WP-06 FR-IMP-08 undo removes new rows and restores updated ones', async () => {
    await runImport(fixture('basic.csv'));
    const before = await liveCount();
    const tagsBefore = (await byPhone('+919876543210'))!.tags;
    const { import_id, result } = await runImport(`Mobile No,Name,Company,Segment\n9876543210,Asha K,Acme,retail\n9900112233,New,Co,x\n`, { commit: { policy: 'overwrite' } });
    expect(result).toMatchObject({ new_rows: 1, updated_rows: 1 });
    const res = await undo(import_id);
    expect(res.status).toBe(200);
    expect(await liveCount()).toBe(before);
    expect(await byPhone('+919900112233')).toBeUndefined();
    expect(await byPhone('+919876543210')).toMatchObject({ firstName: 'Asha', company: null, tags: tagsBefore });
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, import_id));
    expect(batch!.status).toBe('undone');
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'import.undo'))).toHaveLength(1);
    expect(await db.select().from(contactImportChanges)).toEqual([]);
  });

  it('WP-07 a later user change blocks undo, and the change stays', async () => {
    const { import_id } = await runImport(csv('9876543210,A'));
    // Stands in for the P3 bulk-tag route: one user data change and its revision bump.
    await db.transaction(async (tx) => {
      await tx.update(contacts).set({ tags: ['bulk'] });
      await new ContactStore(tx).bumpRevision();
    });
    const res = await undo(import_id);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/changed since/);
    expect((await byPhone('+919876543210'))?.tags).toEqual(['bulk']);
    const info = await (await importRoute.GET(new Request('http://x'), { params: Promise.resolve({ id: import_id }) })).json();
    expect(info.undo_blocked_reason).toMatch(/changed since/);
  });

  it('WP-08 undo is allowed after a STOP and leaves the existing number opted out', async () => {
    await runImport(csv('9876543210,Existing'));
    const second = await runImport(csv('9876543210,Existing', '9812345678,New'), { options: { opt_in_value: 'opted_in' }, commit: { consent_confirmed: true } });
    expect((await byPhone('+919876543210'))?.optInStatus).toBe('opted_in');
    await db.transaction(async (tx) => {
      for (const identifier of ['+919876543210', '+919812345678']) await addSuppression(tx, { channel: 'whatsapp', identifier, reason: 'stop_keyword' });
    });
    expect((await undo(second.import_id)).status).toBe(200);
    expect((await byPhone('+919876543210'))?.optInStatus).toBe('opted_out');
    // The contact this import created is gone, but its opt-out still applies if it comes back.
    expect(await byPhone('+919812345678')).toBeUndefined();
    await runImport(csv('9812345678,Again'), { options: { opt_in_value: 'opted_in' } });
    expect((await byPhone('+919812345678'))?.optInStatus).toBe('opted_out');
  });

  it('undoing a phone added to an email-only contact keeps the opt-out consistent', async () => {
    await runImport('email,name\nhans@example.de,Hans\n');
    const second = await runImport('phone,email\n9876543210,hans@example.de\n');
    expect(await byEmail('hans@example.de')).toMatchObject({ phoneE164: '+919876543210' });
    expect((await undo(second.import_id)).status).toBe(200);
    expect(await byEmail('hans@example.de')).toMatchObject({ phoneE164: null, waTo: null, optInStatus: 'unknown' });
  });

  it('in-file: a later row adds a phone to an email-only contact created earlier in the file', async () => {
    const { summary, result } = await runImport('phone,email,name\n,hans@example.de,Hans\n9876543210,hans@example.de,Hans W\n');
    expect(summary).toMatchObject({ valid_new: 1, duplicates_in_file: 1 });
    expect(result.new_rows).toBe(1);
    expect(await byEmail('hans@example.de')).toMatchObject({ phoneE164: '+919876543210', waTo: '919876543210', firstName: 'Hans', countryIso: 'IN' });
  });

  it('a re-import after undo works, and the file is not reported as a duplicate', async () => {
    const first = await runImport(csv('9876543210,A'), { name: 'a.csv' });
    await undo(first.import_id);
    const again = await runImport(csv('9876543210,A'), { name: 'a.csv' });
    expect(again.duplicate_of).toBeUndefined();
    expect(again.result.new_rows).toBe(1);
  });

  it('a soft-deleted contact is ignored when matching, so re-importing creates a new one', async () => {
    await runImport(csv('9876543210,A'));
    await db.update(contacts).set({ isDeleted: true, deletedAt: new Date() });
    const { result } = await runImport(csv('9876543210,B'));
    expect(result.new_rows).toBe(1);
    expect(await liveCount()).toBe(1);
  });

  it('no personal data in the audit trail of an import', async () => {
    await runImport('phone,email,name\n9876543210,asha@example.org,Asha\n');
    const rows = await db.select().from(auditLog);
    expect(JSON.stringify(rows)).not.toContain('9876543210');
    expect(JSON.stringify(rows)).not.toContain('asha@example.org');
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['import.register', 'import.analyze', 'import.validate', 'import.commit']));
  });
});

describe('AU-01 import routes each write exactly one audit row', () => {
  it('register, analyze, validate, commit, undo, and a refused commit writes none', async () => {
    const { import_id } = await upload('phone\n9876543210\n');
    const counts = async () => (await db.select().from(auditLog)).map((r) => r.action);
    expect(await counts()).toEqual(['import.register']);
    const { suggestions } = await (await analyze(import_id)).json();
    await validate(import_id, { mapping: suggestions, options: { opt_in_value: 'opted_in' } });
    expect(await counts()).toEqual(['import.register', 'import.analyze', 'import.validate']);
    expect((await commit(import_id, {})).status).toBe(422);
    expect(await counts()).toEqual(['import.register', 'import.analyze', 'import.validate']);
    expect((await commit(import_id, { consent_confirmed: true })).status).toBe(200);
    await undo(import_id);
    expect(await counts()).toEqual(['import.register', 'import.analyze', 'import.validate', 'import.commit', 'import.undo']);
    const [commitRow] = await db.select().from(auditLog).where(eq(auditLog.action, 'import.commit'));
    expect(commitRow).toMatchObject({ entity: 'import_batches', entityId: import_id, userId: 'user_asha', userEmail: ME });
  });
});

describe('T2.3 WP-05 the database rejects bad contacts', () => {
  const attempt = (values: typeof contacts.$inferInsert) =>
    db.transaction(async (tx) => {
      await tx.insert(contacts).values(values);
    });
  it('duplicate phone, duplicate email-only address, and no identifier', async () => {
    await db.insert(contacts).values([{ phoneE164: '+919876543210' }, { email: 'a@example.com' }]);
    await expect(attempt({ phoneE164: '+919876543210' })).rejects.toThrow();
    await expect(attempt({ email: 'a@example.com' })).rejects.toThrow();
    await expect(attempt({})).rejects.toThrow();
    expect(await liveCount()).toBe(2);
    // Sharing an address is allowed for contacts with phones (§4.1).
    await attempt({ phoneE164: '+919812345678', email: 'a@example.com' });
  });
});

describe('T2.4 suppression', () => {
  const call = (fn: (typeof suppressionRoute)['POST'], channel: string, body: object, method: string) =>
    fn(new Request(`http://localhost/api/suppression?channel=${channel}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), none);

  it('AU-02 removal needs a reason, and is audited', async () => {
    await call(suppressionRoute.POST, 'whatsapp', { identifier: '98765 43210' }, 'POST');
    expect((await call(suppressionRoute.DELETE, 'whatsapp', { identifier: '+919876543210' }, 'DELETE')).status).toBe(400);
    expect((await call(suppressionRoute.DELETE, 'whatsapp', { identifier: '+919876543210', reason: '  ' }, 'DELETE')).status).toBe(400);
    expect(await db.select().from(suppressionList)).toHaveLength(1);
    expect((await call(suppressionRoute.DELETE, 'whatsapp', { identifier: '+919876543210', reason: 'Asked to rejoin' }, 'DELETE')).status).toBe(200);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, 'suppression.remove'));
    expect(row).toMatchObject({ detailsJson: { reason: 'Asked to rejoin', channel: 'whatsapp' } });
    expect(row!.entityId).not.toContain('98765432');
  });

  it("one channel's opt-out leaves the other unchanged", async () => {
    await db.insert(contacts).values({ phoneE164: '+919876543210', email: 'a@example.com', optInStatus: 'opted_in', emailOptInStatus: 'opted_in' });
    await call(suppressionRoute.POST, 'whatsapp', { identifier: '+919876543210' }, 'POST');
    expect(await byPhone('+919876543210')).toMatchObject({ optInStatus: 'opted_out', emailOptInStatus: 'opted_in' });
    await call(suppressionRoute.DELETE, 'whatsapp', { identifier: '+919876543210', reason: 'x' }, 'DELETE');
    await call(suppressionRoute.POST, 'email', { identifier: 'A@Example.com' }, 'POST');
    expect(await byPhone('+919876543210')).toMatchObject({ optInStatus: 'unknown', emailOptInStatus: 'opted_out' });
  });

  it('§4.4 removal gives `unknown`, never opted in', async () => {
    await db.insert(contacts).values({ phoneE164: '+919876543210', optInStatus: 'opted_in' });
    await call(suppressionRoute.POST, 'whatsapp', { identifier: '+919876543210' }, 'POST');
    await call(suppressionRoute.DELETE, 'whatsapp', { identifier: '+919876543210', reason: 'x' }, 'DELETE');
    expect((await byPhone('+919876543210'))?.optInStatus).toBe('unknown');
  });

  it('§4.4 an opt-out with no contact is stored, and applies on a later import', async () => {
    await call(suppressionRoute.POST, 'email', { identifier: 'later@example.com' }, 'POST');
    await runImport('email\nlater@example.com\n', { options: { email_opt_in_value: 'opted_in' } });
    expect((await byEmail('later@example.com'))?.emailOptInStatus).toBe('opted_out');
  });

  it('refuses an invalid identifier and channel', async () => {
    expect((await call(suppressionRoute.POST, 'whatsapp', { identifier: '12345' }, 'POST')).status).toBe(400);
    expect((await call(suppressionRoute.POST, 'sms', { identifier: '+919876543210' }, 'POST')).status).toBe(400);
  });

  it('does not bump the contact revision', async () => {
    await call(suppressionRoute.POST, 'whatsapp', { identifier: '+919876543210' }, 'POST');
    expect(await revision()).toBe(0);
  });
});

describe('T2.5 upload', () => {
  const token = (body: object) =>
    uploadTokenRoute.POST(new Request('http://localhost/api/imports/upload-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), none);

  it('SEC-09 refuses too large and the wrong type', async () => {
    expect((await token({ file_name: 'a.csv', size: 60 * 1024 * 1024, content_type: 'text/csv' })).status).toBe(413);
    expect((await token({ file_name: 'a.csv', size: 100, content_type: 'application/x-msdownload' })).status).toBe(415);
    expect((await token({ file_name: 'a.exe', size: 100, content_type: '' })).status).toBe(415);
  });

  it('accepts the types browsers report for a CSV', async () => {
    for (const content_type of ['text/csv', 'application/vnd.ms-excel', 'text/plain', '']) {
      const res = await token({ file_name: 'a.csv', size: 30 * 1024 * 1024, content_type });
      expect(res.status, content_type).toBe(200);
      expect((await res.json()).blob_path).toMatch(/^dev\/imports\/[0-9a-f-]{36}\/source\.csv$/);
    }
  });

  it("the configured size limit applies", async () => {
    await db.insert(schema.settings).values({ key: 'import', valueJson: { maxFileSizeMb: 1 } });
    expect((await token({ file_name: 'a.csv', size: 2 * 1024 * 1024, content_type: 'text/csv' })).status).toBe(413);
  });

  it('refuses a path this app did not issue, and a hash that does not match', async () => {
    const { POST } = await import('@/app/api/imports/route');
    const reg = (body: object) => POST(new Request('http://localhost/api/imports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), none);
    const sha256 = 'a'.repeat(64);
    expect((await reg({ blob_path: 'prod/imports/00000000-0000-0000-0000-000000000000/source.csv', file_name: 'a.csv', sha256 })).status).toBe(400);
    expect((await reg({ blob_path: 'dev/snapshots/s000001.parquet', file_name: 'a.csv', sha256 })).status).toBe(400);
    const path = 'dev/imports/00000000-0000-0000-0000-000000000000/source.csv';
    const { getBlobStore } = await import('@/lib/storage/blob');
    await getBlobStore().put(path, 'phone\n', 'text/csv');
    expect((await reg({ blob_path: path, file_name: 'a.csv', sha256 })).status).toBe(400);
  });
});

describe('T2.6 SEC-11 limits', () => {
  it('200k + 1 rows is rejected with the limit message', async () => {
    const { import_id } = await upload(`phone\n${'9876543210\n'.repeat(200_001)}`);
    const res = await analyze(import_id);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/200,000 rows/);
  });

  it('validate refuses a mapping with neither phone nor email', async () => {
    const { import_id } = await upload('name\nAsha\n');
    await analyze(import_id);
    const res = await validate(import_id, { mapping: { 0: 'first_name' } });
    expect(res.status).toBe(400);
  });
});

describe('T2.7 mapping presets', () => {
  const save = (body: object) => presetsRoute.POST(new Request('http://localhost/api/mapping-presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), none);

  it('FR-IMP-09 a preset applies to a file with the same headers', async () => {
    const { import_id } = await upload('Mobile No,Foo\n9876543210,x\n');
    const analysis = await (await analyze(import_id)).json();
    expect(analysis.preset).toBeNull();
    const res = await save({ name: 'Expo', header_signature: analysis.header_signature, mapping: { 0: 'phone', 1: 'city' } });
    expect(res.status).toBe(201);

    const again = await upload('mobile_no,FOO\n9812345678,y\n');
    expect((await (await analyze(again.import_id)).json()).preset).toMatchObject({ name: 'Expo', mapping: { 0: 'phone', 1: 'city' } });

    const { items } = await (await presetsRoute.GET(new Request('http://x'), none)).json();
    expect(items).toHaveLength(1);
    const del = await presetsRoute.DELETE(new Request('http://localhost/api/mapping-presets', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: items[0].id }) }), none);
    expect(del.status).toBe(200);
  });

  it('refuses a preset with an unusable mapping', async () => {
    expect((await save({ name: 'x', header_signature: 'a', mapping: { 0: 'city' } })).status).toBe(400);
  });
});
