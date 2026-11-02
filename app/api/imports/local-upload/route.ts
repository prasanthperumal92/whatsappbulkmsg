import { withAudit } from '@/lib/api/route';
import { ApiError } from '@/lib/api/errors';
import { importIdFromPath } from '@/lib/imports/service';
import { getSettingsSection } from '@/lib/settings/store';
import { getBlobStore } from '@/lib/storage/blob';

/** Local dev has no Blob store for the browser to upload to, so it uploads here. Refused wherever a real store exists. */
export const PUT = withAudit({ action: 'import.upload_authorised', entity: 'import_batches' }, async (req, { tx, audit }) => {
  const store = getBlobStore();
  if (store.driver !== 'local') throw new ApiError(404, 'not_found', 'Not found');
  const path = new URL(req.url).searchParams.get('path') ?? '';
  const id = importIdFromPath(path);
  if (!id) throw new ApiError(400, 'invalid_blob_path', 'This upload path was not issued by this app.');
  const { maxFileSizeMb } = await getSettingsSection(tx, 'import');
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > maxFileSizeMb * 1024 * 1024) throw new ApiError(413, 'file_too_large', `This file is larger than the ${maxFileSizeMb} MB limit.`);
  await store.put(path, bytes, 'text/csv');
  audit({ entityId: id, details: { size: bytes.byteLength } });
  return Response.json({ ok: true });
});
