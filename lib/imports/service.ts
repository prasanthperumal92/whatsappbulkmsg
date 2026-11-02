import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import Papa from 'papaparse';
import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { ContactStore, type ContactRow } from '@/lib/contacts/store';
import { schema, type Db, type Tx } from '@/lib/db';
import { blobPrefix } from '@/lib/env';
import { getSettings } from '@/lib/settings/store';
import { getBlobStore } from '@/lib/storage/blob';
import { loadSuppressionSets } from '@/lib/suppression/service';
import { columnStats, ImportLimitError, parseCsv, type ParsedCsv, type ParseOptions } from './csv';
import { decodeBytes, detectAll, type Detection, type Encoding } from './detect';
import { headerSignature, mappingProblem, STANDARD_TARGETS, suggestMapping, type Mapping } from './mapping';
import { mergeContact, newContact, type ExistingPolicy, type MergeContext } from './merge';
import { buildPlan, type ImportPlan, type ImportSummary } from './plan';
import { buildReader, normaliseRow, type RowOptions } from './rows';

const { importBatches, mappingPresets, contactImportChanges } = schema;

type Batch = typeof importBatches.$inferSelect;
type Actor = { id: string; email: string };

const consent = z.enum(['opted_in', 'unknown', 'opted_out']);
const target = z.union([z.enum(STANDARD_TARGETS), z.templateLiteral(['custom:', z.string().min(1)]), z.null()]);

/** Detection overrides from Step 1. Anything left out keeps the detected value. */
export const parseOverrides = z.object({
  encoding: z.enum(['utf-8', 'windows-1252', 'utf-16le', 'utf-16be']).optional(),
  delimiter: z.string().min(1).max(4).optional(),
  quote: z.string().length(1).optional(),
  header_row: z.boolean().optional(),
  rows_to_skip: z.number().int().min(0).max(1000).optional(),
});
export type ParseOverrides = z.output<typeof parseOverrides>;

export const validateBody = z.object({
  mapping: z.record(z.string().regex(/^\d+$/), target),
  options: parseOverrides
    .extend({
      default_country: z.string().regex(/^[A-Z]{2}$/).optional(),
      tag_separator: z.string().min(1).max(4).default(';'),
      apply_tags: z.array(z.string()).default([]),
      opt_in_value: consent.optional(),
      email_opt_in_value: consent.optional(),
      consent_proof_value: z.string().trim().min(1).nullable().default(null),
    })
    .prefault({}),
});

export const commitBody = z.object({
  policy: z.enum(['skip', 'fill_empty', 'overwrite']).optional(),
  consent_confirmed: z.boolean().default(false),
  email_consent_confirmed: z.boolean().default(false),
});

const IMPORT_ID = '[0-9a-f-]{36}';

export const importBlobPath = (id: string, file: 'source.csv' | 'rejects.csv', env = process.env) => `${blobPrefix(env)}imports/${id}/${file}`;

/** The id inside a path this deployment could have issued, or null. Stops a caller registering someone else's file. */
export function importIdFromPath(path: string, env = process.env): string | null {
  const prefix = blobPrefix(env).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}imports/(${IMPORT_ID})/source\\.csv$`).exec(path)?.[1] ?? null;
}

export async function getBatch(db: Tx, id: string): Promise<Batch> {
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, id));
  if (!batch) throw new ApiError(404, 'import_not_found', 'This import no longer exists.');
  return batch;
}

async function readSource(batch: Batch): Promise<Uint8Array> {
  if (!batch.sourceBlobPath) throw new ApiError(410, 'source_expired', 'This file is no longer available. Please upload it again.');
  const bytes = await getBlobStore().read(batch.sourceBlobPath);
  if (!bytes) throw new ApiError(410, 'source_expired', 'This file is no longer available: uploads are kept for 7 days. Please upload it again.');
  return bytes;
}

const formatDay = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** POST /imports: records the upload. The hash is checked here, because the browser only claims it. */
export async function registerUpload(tx: Tx, input: { blob_path: string; file_name: string; sha256: string }, actor: Actor, maxBytes: number) {
  const id = importIdFromPath(input.blob_path);
  if (!id) throw new ApiError(400, 'invalid_blob_path', 'This upload path was not issued by this app.');
  const bytes = await getBlobStore().read(input.blob_path);
  if (!bytes) throw new ApiError(400, 'upload_not_found', 'The uploaded file could not be found. Please try again.');
  if (bytes.byteLength > maxBytes) throw new ApiError(413, 'file_too_large', `This file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== input.sha256.toLowerCase()) throw new ApiError(400, 'checksum_mismatch', 'The upload was corrupted on the way. Please try again.');

  const [previous] = await tx
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.fileSha256, sha256), eq(importBatches.status, 'committed')))
    .orderBy(desc(importBatches.createdAt))
    .limit(1);

  await tx
    .insert(importBatches)
    .values({ id, fileName: input.file_name, fileSha256: sha256, sourceBlobPath: input.blob_path, status: 'uploaded', createdBy: actor.id, createdByEmail: actor.email })
    .onConflictDoNothing();

  return {
    import_id: id,
    ...(previous && {
      duplicate_of: {
        import_id: previous.id,
        message: `This file was already imported on ${formatDay(previous.createdAt)} by ${previous.createdByEmail ?? 'a team member'}.`,
      },
    }),
  };
}

type ResolvedParse = ParseOptions & { encoding: Encoding };

function detectAndParse(bytes: Uint8Array, overrides: ParseOverrides): { detect: Detection; csv: ParsedCsv } {
  const detected = detectAll(bytes);
  const { text: detectedText, ...detection } = detected;
  // Detection re-runs on the chosen encoding, because an override can change what the delimiter looks like.
  const redetect = overrides.encoding && overrides.encoding !== detection.encoding ? detectAll(new TextEncoder().encode(decodeBytes(bytes, overrides.encoding))) : null;
  const base = redetect ? { ...redetect, encoding: overrides.encoding!, bom_stripped: detection.bom_stripped } : detection;
  const text = redetect ? decodeBytes(bytes, overrides.encoding!) : detectedText;
  const detect: Detection = {
    encoding: base.encoding,
    bom_stripped: base.bom_stripped,
    delimiter: overrides.delimiter ?? base.delimiter,
    quote: overrides.quote ?? base.quote,
    header_row: overrides.header_row ?? base.header_row,
    rows_to_skip: overrides.rows_to_skip ?? base.rows_to_skip,
  };
  try {
    return { detect, csv: parseCsv(text, detect) };
  } catch (err) {
    if (err instanceof ImportLimitError) throw new ApiError(422, 'file_limit_exceeded', err.message);
    throw err;
  }
}

/** POST /imports/{id}/analyze. */
export async function analyzeImport(tx: Tx, id: string, overrides: ParseOverrides) {
  const batch = await getBatch(tx, id);
  const { detect, csv } = detectAndParse(await readSource(batch), overrides);
  await tx.update(importBatches).set({ optionsJson: { ...(batch.optionsJson as object | null), ...detect } }).where(eq(importBatches.id, id));

  const signature = detect.header_row ? headerSignature(csv.headers) : null;
  const [preset] = signature ? await tx.select().from(mappingPresets).where(eq(mappingPresets.headerSignature, signature)).limit(1) : [];
  const suggestions = suggestMapping(detect.header_row ? csv.headers : []);
  return {
    detect,
    total_rows: csv.rows.length,
    columns: columnStats(csv),
    preview_headers: csv.headers,
    preview_rows: csv.rows.slice(0, 200),
    suggestions,
    auto_mapping: Object.fromEntries(csv.headers.map((h, i) => [h, suggestions[i] ?? null])),
    header_signature: signature,
    preset: preset ? { id: preset.id, name: preset.name, mapping: preset.mappingJson as Mapping } : null,
  };
}

type StoredOptions = Partial<ResolvedParse> & Partial<RowOptions>;

async function loadRows(batch: Batch, mapping: Mapping, stored: StoredOptions, defaults: { country: string; whatsapp: RowOptions['opt_in_value']; email: RowOptions['opt_in_value'] }) {
  const { detect, csv } = detectAndParse(await readSource(batch), stored);
  const options: RowOptions = {
    default_country: stored.default_country ?? defaults.country,
    tag_separator: stored.tag_separator ?? ';',
    apply_tags: stored.apply_tags ?? [],
    opt_in_value: stored.opt_in_value ?? defaults.whatsapp,
    email_opt_in_value: stored.email_opt_in_value ?? defaults.email,
    consent_proof_value: stored.consent_proof_value ?? null,
  };
  const reader = buildReader(mapping);
  return { detect, csv, options, rows: csv.rows.map((cells, index) => normaliseRow(cells, index, reader, options)) };
}

async function makePlan(tx: Tx, rows: Awaited<ReturnType<typeof loadRows>>['rows'], restrictedCountries: string[]) {
  const contacts = await new ContactStore(tx).identities();
  const suppressed = await loadSuppressionSets(tx);
  return { suppressed, plan: buildPlan(rows, { contacts, suppressedPhones: suppressed.phones, suppressedEmails: suppressed.emails, restrictedCountries }) };
}

function rejectsCsv(csv: ParsedCsv, rejects: ImportPlan['rejects'], delimiter = ',') {
  const rows = rejects.map(({ index, reason }) => {
    const cells = csv.rows[index] ?? [];
    return [...csv.headers.map((_, i) => cells[i] ?? ''), reason];
  });
  return Papa.unparse({ fields: [...csv.headers, 'reject_reason'], data: rows }, { delimiter });
}

/** POST /imports/{id}/validate. */
export async function validateImport(tx: Tx, id: string, body: z.output<typeof validateBody>): Promise<ImportSummary & { has_rejects: boolean }> {
  const batch = await getBatch(tx, id);
  if (batch.status === 'committed' || batch.status === 'undone') throw new ApiError(409, 'import_closed', 'This import has already been committed. Upload the file again to re-import it.');
  const problem = mappingProblem(body.mapping);
  if (problem) throw new ApiError(400, 'invalid_mapping', problem);

  const settings = await getSettings(tx);
  const stored: StoredOptions = { ...(batch.optionsJson as StoredOptions | null), ...stripUndefined(body.options) };
  const { rows, csv, detect, options } = await loadRows(batch, body.mapping, stored, {
    country: settings.import.defaultCountry,
    whatsapp: settings.import.defaultWhatsappOptIn,
    email: settings.import.defaultEmailOptIn,
  });
  const { plan } = await makePlan(tx, rows, settings.whatsappSending.restrictedCountries);

  const has_rejects = plan.rejects.length > 0;
  if (has_rejects) await getBlobStore().put(importBlobPath(id, 'rejects.csv'), rejectsCsv(csv, plan.rejects), 'text/csv');
  else await getBlobStore().remove([importBlobPath(id, 'rejects.csv')]);

  await tx
    .update(importBatches)
    .set({ status: 'validated', mappingJson: body.mapping, optionsJson: { ...detect, ...options }, totalsJson: plan.summary })
    .where(eq(importBatches.id, id));
  return { ...plan.summary, has_rejects };
}

const stripUndefined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

const COMMIT_MARK_TTL_MINUTES = 10;

/** Who's committing, written on its own connection so it's visible while the import transaction is open. */
export const markCommitStarted = (db: Db, id: string, email: string) =>
  db.update(importBatches).set({ commitStartedAt: new Date(), commitStartedBy: email }).where(eq(importBatches.id, id));

export const clearCommitMark = (db: Tx, id: string) => db.update(importBatches).set({ commitStartedAt: null, commitStartedBy: null }).where(eq(importBatches.id, id));

/** §5.3: "An import by Ravi is in progress". The expiry covers a function killed mid-commit. */
export async function activeCommit(db: Tx) {
  const since = new Date(Date.now() - COMMIT_MARK_TTL_MINUTES * 60_000);
  const [row] = await db
    .select({ id: importBatches.id, by: importBatches.commitStartedBy, file_name: importBatches.fileName, started_at: importBatches.commitStartedAt })
    .from(importBatches)
    .where(and(isNotNull(importBatches.commitStartedAt), gt(importBatches.commitStartedAt, since)))
    .limit(1);
  return row ?? null;
}

export type CommitResult = { import_id: string; new_rows: number; updated_rows: number; unchanged_rows: number; summary: ImportSummary; post_revision: number };

/**
 * POST /imports/{id}/commit (§4.2). Runs in the route's transaction, so everything here, the audit row
 * included, commits or rolls back together. The file is read before taking the lock to keep the lock short.
 */
export async function commitImport(tx: Tx, id: string, body: z.output<typeof commitBody>, actor: Actor): Promise<CommitResult> {
  const before = await getBatch(tx, id);
  if (!before.mappingJson) throw new ApiError(409, 'not_validated', 'Validate this import before committing it.');
  const settings = await getSettings(tx);
  const loaded = await loadRows(before, before.mappingJson as Mapping, before.optionsJson as StoredOptions, {
    country: settings.import.defaultCountry,
    whatsapp: settings.import.defaultWhatsappOptIn,
    email: settings.import.defaultEmailOptIn,
  });

  const store = new ContactStore(tx);
  await store.lockForImport();

  // Re-read under the lock: an identical request may have committed while this one waited.
  const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, id)).for('update');
  if (!batch || (batch.status !== 'validated' && batch.status !== 'failed')) {
    throw new ApiError(409, 'not_validated', 'This import can no longer be committed.');
  }

  // WP-03: match again under the lock, because contacts may have changed since Step 3.
  const { plan, suppressed } = await makePlan(tx, loaded.rows, settings.whatsappSending.restrictedCountries);
  if (plan.summary.would_opt_in > 0 && !body.consent_confirmed) {
    throw new ApiError(422, 'consent_required', 'Confirm that these contacts agreed to receive WhatsApp marketing messages.');
  }
  if (plan.summary.would_email_opt_in > 0 && !body.email_consent_confirmed) {
    throw new ApiError(422, 'email_consent_required', 'Confirm that these contacts agreed to receive marketing emails.');
  }

  const now = new Date().toISOString();
  const ctx: MergeContext = {
    batchId: id,
    source: `csv:${batch.fileName}`,
    now,
    userId: actor.id,
    suppressedPhones: suppressed.phones,
    suppressedEmails: suppressed.emails,
  };
  const policy: ExistingPolicy = body.policy ?? settings.import.existingContactPolicy;

  const inserts: ContactRow[] = [];
  const updates: ContactRow[] = [];
  const changes: { contact_id: string; operation: 'insert' | 'update'; previous_json: ContactRow | null }[] = [];
  const matchEntries = plan.entries.filter((e) => e.kind === 'match');
  const existing = new Map((await store.getMany(matchEntries.map((e) => e.contact_id))).map((c) => [c.contact_id, c]));

  for (const entry of plan.entries) {
    if (entry.kind === 'create') {
      const contact = newContact(entry.contact_id, entry.row, ctx);
      if (entry.add_phone) {
        contact.phone_e164 = entry.add_phone.phone;
        contact.wa_to = entry.add_phone.wa_to;
        contact.country_iso ??= entry.add_phone.country;
        contact.time_zone ??= entry.add_phone.time_zone;
        Object.assign(contact, whatsappFor(entry.add_phone, ctx));
      }
      inserts.push(contact);
      changes.push({ contact_id: contact.contact_id, operation: 'insert', previous_json: null });
      continue;
    }
    const current = existing.get(entry.contact_id);
    if (!current) continue;
    const merged = mergeContact(current, entry.row, entry.add_phone, policy, ctx);
    if (merged) {
      updates.push(merged);
      changes.push({ contact_id: merged.contact_id, operation: 'update', previous_json: current });
    }
  }

  const pre_revision = await store.revision();
  const post_revision = await store.bumpRevision();
  await store.insertMany(inserts);
  await store.updateMany(updates);
  await writeChanges(tx, id, changes);

  const consentJson = {
    ...(plan.summary.would_opt_in > 0 && { whatsapp: { confirmed_by: actor.email, confirmed_at: now } }),
    ...(plan.summary.would_email_opt_in > 0 && { email: { confirmed_by: actor.email, confirmed_at: now } }),
  };
  const result: CommitResult = {
    import_id: id,
    new_rows: inserts.length,
    updated_rows: updates.length,
    unchanged_rows: matchEntries.length - updates.length,
    summary: plan.summary,
    post_revision,
  };
  await tx
    .update(importBatches)
    .set({
      status: 'committed',
      preRevision: pre_revision,
      postRevision: post_revision,
      consentJson,
      totalsJson: { ...plan.summary, new_rows: result.new_rows, updated_rows: result.updated_rows, unchanged_rows: result.unchanged_rows, policy },
      commitStartedAt: null,
      commitStartedBy: null,
    })
    .where(eq(importBatches.id, id));
  return result;
}

function whatsappFor(row: { phone: string | null; opt_in: string }, ctx: MergeContext) {
  if (ctx.suppressedPhones.has(row.phone!)) return { opt_in_status: 'opted_out', opt_in_source: null, opt_in_at: null };
  if (row.opt_in === 'unknown') return { opt_in_status: 'unknown', opt_in_source: null, opt_in_at: null };
  return { opt_in_status: row.opt_in, opt_in_source: ctx.source, opt_in_at: ctx.now };
}

async function writeChanges(tx: Tx, batchId: string, changes: { contact_id: string; operation: string; previous_json: ContactRow | null }[]) {
  for (let i = 0; i < changes.length; i += 2000) {
    const json = JSON.stringify(changes.slice(i, i + 2000));
    await tx.execute(sql`
      INSERT INTO contact_import_changes (import_batch_id, contact_id, operation, previous_json)
      SELECT ${batchId}, r.contact_id, r.operation, r.previous_json
      FROM jsonb_to_recordset(${json}::jsonb) AS r(contact_id uuid, operation varchar, previous_json jsonb)`);
  }
}

/** Why this batch can't be undone, or null if it can. */
export function undoBlockedReason(batch: Pick<Batch, 'status' | 'postRevision'>, revision: number): string | null {
  if (batch.status !== 'committed') return 'Only a committed import can be undone.';
  if (batch.postRevision !== revision) return 'Contacts have changed since this import, so it can no longer be undone.';
  return null;
}

/** POST /imports/{id}/undo (§4.2). A suppression that arrived since never blocks this, and is never reversed (§4.4). */
export async function undoImport(tx: Tx, id: string) {
  const store = new ContactStore(tx);
  await store.lockForImport();
  const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, id)).for('update');
  if (!batch) throw new ApiError(404, 'import_not_found', 'This import no longer exists.');
  const blocked = undoBlockedReason(batch, await store.revision());
  if (blocked) throw new ApiError(409, 'undo_not_allowed', blocked);

  const changes = await tx.select().from(contactImportChanges).where(eq(contactImportChanges.importBatchId, id));
  const inserted = changes.filter((c) => c.operation === 'insert').map((c) => c.contactId);
  const updated = changes.filter((c) => c.operation === 'update');
  const current = new Map((await store.getMany(updated.map((c) => c.contactId))).map((c) => [c.contact_id, c]));
  const { phones, emails } = await loadSuppressionSets(tx);

  const restores: ContactRow[] = [];
  for (const change of updated) {
    const now = current.get(change.contactId);
    if (!now) continue; // Erased since (§12A.3).
    const previous = change.previousJson as ContactRow;
    const next: ContactRow = { ...previous };
    if (now.opt_in_status === 'opted_out' || (previous.phone_e164 && phones.has(previous.phone_e164))) {
      Object.assign(next, { opt_in_status: 'opted_out', opt_in_source: now.opt_in_source, opt_in_at: now.opt_in_at });
    }
    if (now.email_opt_in_status === 'opted_out' || (previous.email && emails.has(previous.email))) {
      Object.assign(next, { email_opt_in_status: 'opted_out', email_opt_in_source: now.email_opt_in_source, email_opt_in_at: now.email_opt_in_at });
    }
    restores.push(next);
  }

  await store.hardDelete(inserted);
  await store.updateMany(restores);
  const revision = await store.bumpRevision();
  await tx.update(importBatches).set({ status: 'undone' }).where(eq(importBatches.id, id));
  return { import_id: id, removed_rows: inserted.length, restored_rows: restores.length, revision };
}

/** What GET /imports/{id} returns: the batch, without the storage path. */
export async function describeImport(db: Tx, id: string) {
  const batch = await getBatch(db, id);
  const revision = await new ContactStore(db).revision();
  return {
    id: batch.id,
    file_name: batch.fileName,
    status: batch.status,
    totals: batch.totalsJson,
    created_at: batch.createdAt,
    created_by: batch.createdByEmail,
    undo_blocked_reason: undoBlockedReason(batch, revision),
  };
}

export const failBatch = (db: Db, id: string) =>
  db.update(importBatches).set({ status: 'failed', commitStartedAt: null, commitStartedBy: null }).where(and(eq(importBatches.id, id), inArray(importBatches.status, ['validated', 'failed'])));

