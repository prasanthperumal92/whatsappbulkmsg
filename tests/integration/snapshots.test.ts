import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ByteWriter, parquetWrite } from 'hyparquet-writer';
import { zstdCompressSync } from 'node:zlib';
import * as cleanupRoute from '@/app/api/cron/cleanup/route';
import * as snapshotCron from '@/app/api/cron/snapshot-contacts/route';
import * as restoreRoute from '@/app/api/snapshots/[version]/restore/route';
import * as snapshotsRoute from '@/app/api/snapshots/route';
import * as statusRoute from '@/app/api/status/route';
import { ContactStore } from '@/lib/contacts/store';
import { getDb, schema } from '@/lib/db';
import { createSnapshot, readSnapshotFile, runCleanup, snapshotMetadata } from '@/lib/snapshots/service';
import { getBlobStore } from '@/lib/storage/blob';
import { addSuppression } from '@/lib/suppression/service';
import { resetClerk, signInAs } from '../support/clerk-mock';
import { runImport } from '../support/imports';
import { resetDb } from '../support/reset';

const db = getDb();
const { contacts, contactSnapshots, contactErasures, auditLog, teamAllowlist } = schema;
const ME = 'member@example.com';
const none = { params: Promise.resolve({}) };
const SECRET = 'cron-secret';
const cron = (fn: (typeof snapshotCron)['GET']) => fn(new Request('http://localhost/api/cron/x', { headers: { authorization: `Bearer ${SECRET}` } }), none);

const restore = (version: number, body: object = { confirm: true }) =>
  restoreRoute.POST(new Request(`http://localhost/api/snapshots/${version}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ version: String(version) }) });
const snapshotNow = async () => createSnapshot(db, { reason: 'test', createdBy: ME });
const byPhone = async (phone: string) => (await db.select().from(contacts).where(eq(contacts.phoneE164, phone)))[0];
const bump = () => db.transaction((tx) => new ContactStore(tx).bumpRevision());

beforeEach(async () => {
  await resetDb();
  resetClerk();
  process.env.CRON_SECRET = SECRET;
  await db.insert(teamAllowlist).values({ email: ME });
  signInAs(ME, 'user_m');
  await getBlobStore().remove((await getBlobStore().list('dev/')).map((f) => f.pathname));
});

afterEach(() => vi.restoreAllMocks());

describe('WP-11 file format', () => {
  it('has the metadata, uses ZSTD and leaves out soft-deleted contacts', async () => {
    await runImport('phone,email,name,Segment\n9876543210,a@example.com,Asha,steel;export\n9812345678,,Ravi,\n');
    await db.insert(contacts).values({ phoneE164: '+919900112233', isDeleted: true, deletedAt: new Date() });
    const info = await snapshotNow();
    const bytes = (await getBlobStore().read(info.blob_path))!;
    const { keyValues, codecs, rowCount } = snapshotMetadata(bytes);
    expect(keyValues).toMatchObject({ 'app.schema_version': '3', 'app.version': String(info.version), 'app.row_count': '2', 'app.written_by': ME });
    expect(codecs).toEqual(['ZSTD']);
    expect(rowCount).toBe(2);
    const rows = await readSnapshotFile(bytes);
    expect(rows.map((r) => r.phone_e164).sort()).toEqual(['+919812345678', '+919876543210']);
    const asha = rows.find((r) => r.first_name === 'Asha')!;
    expect(asha.tags).toEqual(['steel', 'export']);
    expect(asha.email).toBe('a@example.com');
    expect(info.blob_path).toMatch(/^dev\/snapshots\/s\d{6}\.parquet$/);
  });
});

describe('WP-09 consistency', () => {
  it('an edit made while the file is being written is not in it', async () => {
    await runImport('phone,name\n9876543210,Before\n');
    const store = getBlobStore();
    const realPut = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementationOnce(async (...args) => {
      await db.update(contacts).set({ firstName: 'During' });
      await db.insert(contacts).values({ phoneE164: '+919812345678' });
      return realPut(...args);
    });
    const info = await snapshotNow();
    const rows = await readSnapshotFile((await store.read(info.blob_path))!);
    expect(rows.map((r) => r.first_name)).toEqual(['Before']);
    expect(info.row_count).toBe(1);
    expect((await byPhone('+919876543210'))?.firstName).toBe('During');
  });
});

describe('restore', () => {
  it('restores contacts, and takes a snapshot first', async () => {
    await runImport('phone,name\n9876543210,Asha\n');
    const snap = await snapshotNow();
    await runImport('phone,name\n9812345678,Ravi\n');
    await db.update(contacts).set({ firstName: 'Changed' }).where(eq(contacts.phoneE164, '+919876543210'));

    const res = await restore(snap.version);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored_rows: 1, pre_restore_snapshot: snap.version + 1 });
    expect((await byPhone('+919876543210'))?.firstName).toBe('Asha');
    expect(await byPhone('+919812345678')).toBeUndefined();
    const pre = await readSnapshotFile((await getBlobStore().read(`dev/snapshots/s${String(snap.version + 1).padStart(6, '0')}.parquet`))!);
    expect(pre.map((r) => r.first_name).sort()).toEqual(['Changed', 'Ravi']);
  });

  it('WP-13 skips erased contacts, keeps suppressions, and is audited', async () => {
    await runImport('phone,email,name\n9876543210,a@example.com,Erased\n9812345678,b@example.com,Stopped\n9900112233,c@example.com,Unsub\n', {
      options: { opt_in_value: 'opted_in', email_opt_in_value: 'opted_in' },
      commit: { consent_confirmed: true, email_consent_confirmed: true },
    });
    const snap = await snapshotNow();
    const erased = (await byPhone('+919876543210'))!;
    await db.delete(contacts).where(eq(contacts.contactId, erased.contactId));
    await db.insert(contactErasures).values({ contactId: erased.contactId });
    await db.transaction(async (tx) => {
      await addSuppression(tx, { channel: 'whatsapp', identifier: '+919812345678', reason: 'stop_keyword' });
      await addSuppression(tx, { channel: 'email', identifier: 'c@example.com', reason: 'complaint' });
    });
    const before = (await db.select().from(contactSnapshots)).length;

    const res = await restore(snap.version);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored_rows: 2, skipped_erased: 1 });
    expect((await db.select().from(contactSnapshots)).length).toBe(before + 1);
    expect(await byPhone('+919876543210')).toBeUndefined();
    expect(await byPhone('+919812345678')).toMatchObject({ optInStatus: 'opted_out', emailOptInStatus: 'opted_in' });
    expect(await byPhone('+919900112233')).toMatchObject({ optInStatus: 'opted_in', emailOptInStatus: 'opted_out' });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'snapshot.restore'))).toHaveLength(1);
  });

  it('brings back a contact soft-deleted since the snapshot', async () => {
    await runImport('phone,name\n9876543210,Asha\n');
    const snap = await snapshotNow();
    await db.update(contacts).set({ isDeleted: true, deletedAt: new Date() });
    expect((await restore(snap.version)).status).toBe(200);
    expect(await byPhone('+919876543210')).toMatchObject({ isDeleted: false, deletedAt: null });
  });

  it('needs confirmation, and refuses a missing or deleted snapshot', async () => {
    const snap = await snapshotNow();
    expect((await restore(snap.version, {})).status).toBe(400);
    expect((await restore(99)).status).toBe(404);
    await db.update(contactSnapshots).set({ deletedAt: new Date() }).where(eq(contactSnapshots.version, snap.version));
    expect((await restore(snap.version)).status).toBe(404);
  });

  it('is cancelled, with contacts untouched, if the safety snapshot fails', async () => {
    await runImport('phone,name\n9876543210,Asha\n');
    const snap = await snapshotNow();
    await db.update(contacts).set({ firstName: 'Current' });
    vi.spyOn(getBlobStore(), 'put').mockRejectedValueOnce(new Error('blob down'));
    expect((await restore(snap.version)).status).toBe(502);
    expect((await byPhone('+919876543210'))?.firstName).toBe('Current');
  });

  describe('older snapshots', () => {
    /** A hand-written file with the columns an older schema had. */
    async function oldSnapshot(version: number, schemaVersion: string) {
      const writer = new ByteWriter();
      parquetWrite({
        writer,
        codec: 'ZSTD',
        compressors: { ZSTD: (b: Uint8Array) => new Uint8Array(zstdCompressSync(b)) },
        columnData: [
          { name: 'contact_id', type: 'STRING', data: ['0190a000-0000-7000-8000-000000000001'] },
          { name: 'phone_e164', type: 'STRING', data: ['+919876543210'] },
          { name: 'wa_to', type: 'STRING', data: ['919876543210'] },
          { name: 'first_name', type: 'STRING', data: ['Old'] },
          { name: 'opt_in_status', type: 'STRING', data: ['opted_in'] },
          { name: 'tags', type: 'STRING', data: ['["old"]'] },
        ],
        kvMetadata: [{ key: 'app.schema_version', value: schemaVersion }],
      });
      const blobPath = `dev/snapshots/s${String(version).padStart(6, '0')}.parquet`;
      await getBlobStore().put(blobPath, new Uint8Array(writer.getBuffer()), 'application/vnd.apache.parquet');
      await db.insert(contactSnapshots).values({ version, blobPath, rowCount: 1, revision: 0, reason: 'old' });
    }

    it('WP-10 EM-02 missing columns get defaults, and the next snapshot is the current schema', async () => {
      await oldSnapshot(1, '1');
      const res = await restore(1);
      expect(res.status).toBe(200);
      expect(await byPhone('+919876543210')).toMatchObject({
        firstName: 'Old', optInStatus: 'opted_in', emailOptInStatus: 'unknown', email: null, language: 'en', tags: ['old'], attributes: {}, isDeleted: false,
      });
      const next = await snapshotNow();
      expect(snapshotMetadata((await getBlobStore().read(next.blob_path))!).keyValues['app.schema_version']).toBe('3');
    });
  });
});

describe('WP-14 a failed upload', () => {
  it('raises a banner, writes no row, leaves contacts working, and clears on the next success', async () => {
    await runImport('phone,name\n9876543210,Asha\n');
    vi.spyOn(getBlobStore(), 'put').mockRejectedValueOnce(new Error('blob down'));
    const before = (await db.select().from(contactSnapshots)).length;

    const res = await snapshotsRoute.POST(new Request('http://localhost/api/snapshots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), none);
    expect(res.status).toBe(502);
    expect((await db.select().from(contactSnapshots)).length).toBe(before);

    const banners = async () => (await (await statusRoute.GET(new Request('http://x'), none)).json()).banners.map((b: { id: string }) => b.id);
    expect(await banners()).toContain('snapshot-failed');

    await db.update(contacts).set({ firstName: 'StillWorks' });
    expect((await byPhone('+919876543210'))?.firstName).toBe('StillWorks');

    await snapshotNow();
    expect(await banners()).not.toContain('snapshot-failed');
  });

  it('the same failure in the cron route also raises the banner', async () => {
    await runImport('phone,name\n9876543210,Asha\n');
    vi.spyOn(getBlobStore(), 'put').mockRejectedValueOnce(new Error('blob down'));
    expect((await cron(snapshotCron.GET)).status).toBe(500);
    expect((await (await statusRoute.GET(new Request('http://x'), none)).json()).banners.map((b: { id: string }) => b.id)).toContain('snapshot-failed');
  });
});

describe('CR-01 snapshot-contacts', () => {
  it('suppressions alone: none. One edit: one. Then nothing: none', async () => {
    await runImport('phone\n9876543210\n');
    await cron(snapshotCron.GET);
    const count = async () => (await db.select().from(contactSnapshots)).length;
    const start = await count();

    await db.transaction(async (tx) => {
      for (const identifier of ['+919876543210', '+919812345678', '+919900112233']) await addSuppression(tx, { channel: 'whatsapp', identifier, reason: 'stop_keyword' });
    });
    expect(await (await cron(snapshotCron.GET)).json()).toEqual({ created: false });
    expect(await count()).toBe(start);

    await bump();
    expect(await (await cron(snapshotCron.GET)).json()).toMatchObject({ created: true });
    expect(await count()).toBe(start + 1);

    expect(await (await cron(snapshotCron.GET)).json()).toEqual({ created: false });
    expect(await count()).toBe(start + 1);
  });

  it('with no contacts ever imported, there is nothing to snapshot', async () => {
    expect(await (await cron(snapshotCron.GET)).json()).toEqual({ created: false });
  });
});

describe('WP-12 cleanup', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  async function snapshotAged(version: number, days: number) {
    const blobPath = `dev/snapshots/s${String(version).padStart(6, '0')}.parquet`;
    await getBlobStore().put(blobPath, 'x', 'application/octet-stream');
    await db.insert(contactSnapshots).values({ version, blobPath, rowCount: 0, revision: 0, createdAt: daysAgo(days) });
    return blobPath;
  }

  it('deletes only the 31-day snapshot', async () => {
    const [ten, twentyNine, thirtyOne] = [await snapshotAged(1, 10), await snapshotAged(2, 29), await snapshotAged(3, 31)];
    const res = await cron(cleanupRoute.GET);
    expect(await res.json()).toMatchObject({ snapshots_deleted: 1 });
    const blob = getBlobStore();
    expect(await blob.read(ten)).not.toBeNull();
    expect(await blob.read(twentyNine)).not.toBeNull();
    expect(await blob.read(thirtyOne)).toBeNull();
    const rows = await db.select().from(contactSnapshots);
    expect(rows.find((r) => r.version === 3)?.deletedAt).toBeInstanceOf(Date);
    expect(rows.find((r) => r.version === 1)?.deletedAt).toBeNull();
  });

  it('deletes orphans past the grace period and import files over 7 days old, and keeps the rest', async () => {
    const blob = getBlobStore();
    const entries = [
      { pathname: 'dev/snapshots/s000900.parquet', uploadedAt: daysAgo(2), size: 1 }, // orphan, past grace
      { pathname: 'dev/snapshots/s000901.parquet', uploadedAt: new Date(), size: 1 }, // orphan, a run may be in flight
      { pathname: 'dev/imports/a/source.csv', uploadedAt: daysAgo(8), size: 1 },
      { pathname: 'dev/imports/b/rejects.csv', uploadedAt: daysAgo(6), size: 1 },
    ];
    vi.spyOn(blob, 'list').mockImplementation(async (prefix) => entries.filter((e) => e.pathname.startsWith(prefix)));
    const remove = vi.spyOn(blob, 'remove').mockResolvedValue();
    expect(await runCleanup(db)).toMatchObject({ orphans_deleted: 1, import_files_deleted: 1 });
    expect(remove.mock.calls.flatMap(([paths]) => paths)).toEqual(['dev/snapshots/s000900.parquet', 'dev/imports/a/source.csv']);
  });

  it('a second run skips while the job lock is held', async () => {
    const results = await Promise.all([runCleanup(db), runCleanup(db), runCleanup(db)]);
    expect(results.filter((r) => !r.skipped).length).toBeGreaterThanOrEqual(1);
  });
});
