import { withSession } from '@/lib/api/route';
import { ApiError } from '@/lib/api/errors';
import { getBatch, importBlobPath } from '@/lib/imports/service';
import { getBlobStore } from '@/lib/storage/blob';

const NOT_FOUND = () => new ApiError(404, 'no_rejects', 'This import has no rejected rows, or the file has expired.');

/** A signed URL, so large files avoid the 4.5 MB response limit. Local dev has no signing, so `?download=1` serves the file. */
export const GET = withSession(async (req, { db, params }) => {
  const id = params.id as string;
  await getBatch(db, id);
  const path = importBlobPath(id, 'rejects.csv');
  const store = getBlobStore();

  const url = await store.signedDownloadUrl(path, 300);
  if (url) return Response.json({ url });

  if (!new URL(req.url).searchParams.has('download')) {
    if (!(await store.read(path))) throw NOT_FOUND();
    return Response.json({ url: `/api/imports/${encodeURIComponent(id)}/rejects?download=1` });
  }
  const bytes = await store.read(path);
  if (!bytes) throw NOT_FOUND();
  return new Response(Buffer.from(bytes), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="rejects.csv"' },
  });
});
