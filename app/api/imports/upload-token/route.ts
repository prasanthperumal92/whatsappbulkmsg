import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withAudit } from '@/lib/api/route';
import { ApiError, parseJson } from '@/lib/api/errors';
import { importBlobPath } from '@/lib/imports/service';
import { getSettingsSection } from '@/lib/settings/store';
import { getBlobStore } from '@/lib/storage/blob';

const body = z.object({ file_name: z.string().trim().min(1).max(255), size: z.number().int().min(0), content_type: z.string().max(200) });

// Browsers report .csv as any of these, or as nothing at all, depending on the OS. The extension decides then.
const ALLOWED_TYPES = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel', 'text/tab-separated-values'];
const UPLOAD_TYPES = ['text/csv', 'text/plain'];

/** §5.3 and §12: authorises one direct upload. No file passes through this function, so size has no 4.5 MB limit. */
export const POST = withAudit({ action: 'import.upload_authorised', entity: 'import_batches' }, async (req, { tx, audit }) => {
  const { file_name, size, content_type } = await parseJson(req, body);
  const { maxFileSizeMb } = await getSettingsSection(tx, 'import');
  const maxBytes = maxFileSizeMb * 1024 * 1024;
  if (size > maxBytes) throw new ApiError(413, 'file_too_large', `This file is larger than the ${maxFileSizeMb} MB limit.`);
  if (!/\.(csv|txt)$/i.test(file_name)) throw new ApiError(415, 'unsupported_file_type', 'Only .csv and .txt files can be imported.');
  const type = content_type.split(';')[0]!.trim().toLowerCase();
  if (type && !ALLOWED_TYPES.includes(type)) throw new ApiError(415, 'unsupported_file_type', 'Only .csv and .txt files can be imported.');

  const id = randomUUID();
  const blob_path = importBlobPath(id, 'source.csv');
  const authorisation = await getBlobStore().authoriseUpload(blob_path, { maxBytes, contentTypes: UPLOAD_TYPES });
  audit({ entityId: id, details: { file_name, size } });
  return Response.json({ blob_path, ...authorisation });
});
