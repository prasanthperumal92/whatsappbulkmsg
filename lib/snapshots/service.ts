import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { desc, eq, sql } from 'drizzle-orm';
import { parquetMetadata, parquetReadObjects, parquetSchema } from 'hyparquet';
import { ByteWriter, parquetWrite } from 'hyparquet-writer';
import { ApiError } from '@/lib/api/errors';
import { CONTACT_COLUMNS, ContactStore, type ContactRow } from '@/lib/contacts/store';
import { schema, type Db, type Tx } from '@/lib/db';
import { blobPrefix } from '@/lib/env';
import { log } from '@/lib/log';
import { getBlobStore } from '@/lib/storage/blob';
import { reapplySuppressions } from '@/lib/suppression/service';

// §4.2. The writer is hyparquet-writer (docs/spikes/platform.md, still to be confirmed on a deployment), so
// the file is built in memory rather than streamed through /tmp. That's fine at the D8 scale of under 50k.

const { contactSnapshots, contactErasures, settings } = schema;

export const SCHEMA_VERSION = 3;
const SNAPSHOT_LOCK = 727_002;
const FAILURE_KEY = 'system.snapshot_failure';

const STRING = CONTACT_COLUMNS.filter((c) => !['tags', 'attributes', 'is_deleted'].includes(c));

export function writeSnapshotFile(contacts: ContactRow[], version: number, writtenBy: string): Uint8Array {
  const writer = new ByteWriter();
  parquetWrite({
    writer,
    codec: 'ZSTD',
    compressors: { ZSTD: (input: Uint8Array) => new Uint8Array(zstdCompressSync(input)) },
    columnData: [
      ...STRING.map((name) => ({ name, type: 'STRING' as const, data: contacts.map((c) => c[name] as string | null) })),
      // Lists and objects are stored as JSON text: this file is a backup that this app reads back.
      { name: 'tags', type: 'STRING' as const, data: contacts.map((c) => JSON.stringify(c.tags)) },
      { name: 'attributes', type: 'STRING' as const, data: contacts.map((c) => JSON.stringify(c.attributes)) },
    ],
    kvMetadata: [
      { key: 'app.schema_version', value: String(SCHEMA_VERSION) },
      { key: 'app.version', value: String(version) },
      { key: 'app.row_count', value: String(contacts.length) },
      { key: 'app.written_by', value: writtenBy },
    ],
  });
  return new Uint8Array(writer.getBuffer());
}

const toArrayBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export function snapshotMetadata(bytes: Uint8Array) {
  const metadata = parquetMetadata(toArrayBuffer(bytes));
  return {
    keyValues: Object.fromEntries((metadata.key_value_metadata ?? []).map((kv) => [kv.key, kv.value])) as Record<string, string | undefined>,
    codecs: [...new Set(metadata.row_groups.flatMap((g) => g.columns.map((c) => c.meta_data?.codec)))],
    rowCount: Number(metadata.num_rows),
  };
}

/** Reads any snapshot this app has written. Columns an older schema didn't have get their defaults (WP-10). */
export async function readSnapshotFile(bytes: Uint8Array): Promise<Partial<ContactRow>[]> {
  const file = toArrayBuffer(bytes);
  const metadata = parquetMetadata(file);
  const columns = new Set(parquetSchema(metadata).children.map((c) => c.element.name));
  const rows = (await parquetReadObjects({
    file,
    metadata,
    compressors: { ZSTD: (input: Uint8Array) => new Uint8Array(zstdDecompressSync(input)) },
  })) as Record<string, unknown>[];
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of CONTACT_COLUMNS) {
      if (!columns.has(column)) continue;
      const value = row[column];
      out[column] = value instanceof Date ? value.toISOString() : (value ?? null);
    }
    out.tags = typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags ?? []);
    out.attributes = typeof row.attributes === 'string' ? JSON.parse(row.attributes) : (row.attributes ?? {});
    if (!columns.has('email_opt_in_status')) out.email_opt_in_status = 'unknown';
    return out as Partial<ContactRow>;
  });
}

async function recordFailure(db: Tx, err: unknown) {
  const value = { at: new Date().toISOString(), message: err instanceof Error ? err.message.slice(0, 200) : 'Unknown error' };
  await db.insert(settings).values({ key: FAILURE_KEY, valueJson: value }).onConflictDoUpdate({ target: settings.key, set: { valueJson: value } });
}

/** Set while the latest snapshot attempt has failed (§4.2 banner). */
export async function snapshotFailure(db: Tx): Promise<{ at: string; message: string } | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, FAILURE_KEY));
  return (row?.valueJson as { at: string; message: string } | undefined) ?? null;
}

export type SnapshotInfo = { version: number; row_count: number; revision: number; blob_path: string };

/**
 * Writes one snapshot. A failure records the banner and rethrows, and never touches contacts. Runs on its own
 * connections, so a snapshot taken before a restore survives if that restore then fails.
 */
export async function createSnapshot(db: Db, { reason, createdBy }: { reason: string; createdBy: string }): Promise<SnapshotInfo> {
  try {
    const info = await db.transaction(async (lockTx) => {
      await lockTx.execute(sql`SELECT pg_advisory_xact_lock(${SNAPSHOT_LOCK})`);
      const [latest] = await lockTx.select({ version: contactSnapshots.version }).from(contactSnapshots).orderBy(desc(contactSnapshots.version)).limit(1);
      const version = (latest?.version ?? 0) + 1;

      // WP-09: one point in time, however many edits land while this runs.
      const { contacts, revision } = await db.transaction(
        async (read) => {
          const store = new ContactStore(read);
          return { revision: await store.revision(), contacts: await store.listLive() };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );

      const phones = contacts.flatMap((c) => (c.phone_e164 ? [c.phone_e164] : []));
      if (new Set(phones).size !== phones.length) throw new Error('Duplicate phone numbers in the snapshot');

      const bytes = writeSnapshotFile(contacts, version, createdBy);
      if (snapshotMetadata(bytes).rowCount !== contacts.length) throw new Error('Snapshot row count mismatch');

      const blob_path = `${blobPrefix()}snapshots/s${String(version).padStart(6, '0')}.parquet`;
      await getBlobStore().put(blob_path, bytes, 'application/vnd.apache.parquet');
      await lockTx.insert(contactSnapshots).values({ version, blobPath: blob_path, rowCount: contacts.length, revision, reason, createdBy });
      await lockTx.delete(settings).where(eq(settings.key, FAILURE_KEY));
      return { version, row_count: contacts.length, revision, blob_path };
    });
    return info;
  } catch (err) {
    log.error('Snapshot failed', { err });
    await recordFailure(db, err).catch((e) => log.error('Could not record the snapshot failure', { err: e }));
    throw err;
  }
}

/** CR-01: true when contacts have changed since the latest snapshot. Suppression doesn't bump the revision. */
export async function snapshotDue(db: Tx): Promise<boolean> {
  const revision = await new ContactStore(db).revision();
  const [latest] = await db.select({ revision: contactSnapshots.revision }).from(contactSnapshots).orderBy(desc(contactSnapshots.version)).limit(1);
  return latest ? latest.revision !== revision : revision > 0;
}

/** POST /snapshots/{version}/restore. The caller has already taken the pre-restore snapshot. */
export async function restoreSnapshot(tx: Tx, version: number, actorId: string) {
  const [snapshot] = await tx.select().from(contactSnapshots).where(eq(contactSnapshots.version, version));
  if (!snapshot || snapshot.deletedAt) throw new ApiError(404, 'snapshot_not_found', 'This snapshot no longer exists.');
  const bytes = await getBlobStore().read(snapshot.blobPath);
  if (!bytes) throw new ApiError(404, 'snapshot_not_found', 'The file for this snapshot no longer exists.');
  const rows = await readSnapshotFile(bytes);

  const store = new ContactStore(tx);
  await store.lockForImport();

  const erased = new Set((await tx.select({ id: contactErasures.contactId }).from(contactErasures)).map((r) => r.id));
  const restored = rows.filter((r) => !r.contact_id || !erased.has(r.contact_id));
  const skipped = rows.length - restored.length;

  // Soft-deleted rows stay for their purge period (§12A), unless this snapshot brings one back.
  await tx.execute(sql`DELETE FROM contacts WHERE is_deleted = false`);
  await store.hardDelete(restored.flatMap((r) => (r.contact_id ? [r.contact_id] : [])));
  await store.insertMany(restored.map((r) => ({ ...r, updated_by: actorId })));
  await reapplySuppressions(tx);
  const revision = await store.bumpRevision();
  return { version, restored_rows: restored.length, skipped_erased: skipped, revision };
}

const SNAPSHOT_RETENTION_DAYS = 30;
const IMPORT_FILE_RETENTION_DAYS = 7;
const CLEANUP_LOCK = 727_003;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** The T2.10 part of /api/cron/cleanup (§10). T5.13 adds the rest. Skips if another run holds the job lock. */
export async function runCleanup(db: Db, now = new Date()) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${CLEANUP_LOCK}) AS locked`);
    if (!rows[0]?.locked) return { skipped: true as const };

    const blob = getBlobStore();
    const day = 24 * 60 * 60 * 1000;
    const snapshotCutoff = new Date(now.getTime() - SNAPSHOT_RETENTION_DAYS * day);
    const live = await tx.select().from(contactSnapshots);
    const expired = live.filter((s) => !s.deletedAt && s.createdAt < snapshotCutoff);
    await blob.remove(expired.map((s) => s.blobPath));
    for (const snapshot of expired) {
      await tx.update(contactSnapshots).set({ deletedAt: now }).where(eq(contactSnapshots.version, snapshot.version));
    }

    // A file no row points to, such as one whose insert failed after the upload. The grace period covers a run in flight.
    const expiredPaths = new Set(expired.map((s) => s.blobPath));
    const known = new Set(live.filter((s) => !s.deletedAt && !expiredPaths.has(s.blobPath)).map((s) => s.blobPath));
    const orphans = (await blob.list(`${blobPrefix()}snapshots/`)).filter(
      (f) => !known.has(f.pathname) && !expiredPaths.has(f.pathname) && now.getTime() - f.uploadedAt.getTime() > ORPHAN_GRACE_MS,
    );
    await blob.remove(orphans.map((f) => f.pathname));

    // Sources and rejects, including uploads never registered.
    const importCutoff = now.getTime() - IMPORT_FILE_RETENTION_DAYS * day;
    const oldImports = (await blob.list(`${blobPrefix()}imports/`)).filter((f) => f.uploadedAt.getTime() < importCutoff);
    await blob.remove(oldImports.map((f) => f.pathname));

    return { skipped: false as const, snapshots_deleted: expired.length, orphans_deleted: orphans.length, import_files_deleted: oldImports.length };
  });
}
