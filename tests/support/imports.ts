import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as analyzeRoute from '@/app/api/imports/[id]/analyze/route';
import * as commitRoute from '@/app/api/imports/[id]/commit/route';
import * as rejectsRoute from '@/app/api/imports/[id]/rejects/route';
import * as undoRoute from '@/app/api/imports/[id]/undo/route';
import * as validateRoute from '@/app/api/imports/[id]/validate/route';
import * as registerRoute from '@/app/api/imports/route';
import type { Mapping } from '@/lib/imports/mapping';
import { getBlobStore } from '@/lib/storage/blob';

export const fixture = (name: string) => readFileSync(path.join(process.cwd(), 'evals', 'fixtures', name));
const args = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (url: string, body: unknown, method = 'POST') =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function upload(bytes: Uint8Array | string, name = 'file.csv') {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  const blob_path = `dev/imports/${randomUUID()}/source.csv`;
  await getBlobStore().put(blob_path, data, 'text/csv');
  const res = await registerRoute.POST(json('/api/imports', { blob_path, file_name: name, sha256: createHash('sha256').update(data).digest('hex') }), { params: Promise.resolve({}) });
  if (res.status !== 201) throw new Error(`register ${res.status}: ${await res.text()}`);
  return (await res.json()) as { import_id: string; duplicate_of?: { import_id: string; message: string } };
}

export const analyze = (id: string, body: object = {}) => analyzeRoute.POST(json(`/api/imports/${id}/analyze`, body), args(id));
export const validate = (id: string, body: object) => validateRoute.POST(json(`/api/imports/${id}/validate`, body), args(id));
export const commit = (id: string, body: object = {}) => commitRoute.POST(json(`/api/imports/${id}/commit`, body), args(id));
export const undo = (id: string) => undoRoute.POST(json(`/api/imports/${id}/undo`, {}), args(id));
export const rejects = (id: string, query = '') => rejectsRoute.GET(new Request(`http://localhost/api/imports/${id}/rejects${query}`), args(id));

/** Upload, analyze with the given overrides, and validate using the suggested mapping plus `mapping`. */
export async function prepare(bytes: Uint8Array | string, opts: { parse?: object; mapping?: Mapping; options?: object; name?: string } = {}) {
  const { import_id, duplicate_of } = await upload(bytes, opts.name);
  const analyzed = await analyze(import_id, opts.parse ?? {});
  if (analyzed.status !== 200) throw new Error(`analyze ${analyzed.status}: ${await analyzed.text()}`);
  const analysis = await analyzed.json();
  const validated = await validate(import_id, { mapping: { ...analysis.suggestions, ...opts.mapping }, options: { ...opts.parse, ...opts.options } });
  if (validated.status !== 200) throw new Error(`validate ${validated.status}: ${await validated.text()}`);
  return { import_id, duplicate_of, analysis, summary: await validated.json() };
}

/** Prepare, then commit. Throws unless the commit succeeds. */
export async function runImport(bytes: Uint8Array | string, opts: Parameters<typeof prepare>[1] & { commit?: object } = {}) {
  const prepared = await prepare(bytes, opts);
  const res = await commit(prepared.import_id, opts.commit ?? {});
  if (res.status !== 200) throw new Error(`commit ${res.status}: ${await res.text()}`);
  return { ...prepared, result: await res.json() };
}
