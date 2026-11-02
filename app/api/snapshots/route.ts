import { desc, isNull } from 'drizzle-orm';
import { withAudit, withSession } from '@/lib/api/route';
import { ApiError } from '@/lib/api/errors';
import { getDb, schema } from '@/lib/db';
import { createSnapshot } from '@/lib/snapshots/service';

const { contactSnapshots } = schema;

export const GET = withSession(async (_req, { db }) => {
  const rows = await db.select().from(contactSnapshots).where(isNull(contactSnapshots.deletedAt)).orderBy(desc(contactSnapshots.version));
  return Response.json({ items: rows.map(({ blobPath: _hidden, ...rest }) => rest) });
});

export const POST = withAudit({ action: 'snapshot.create', entity: 'contact_snapshots' }, async (_req, { user, audit }) => {
  try {
    const info = await createSnapshot(getDb(), { reason: 'manual', createdBy: user.email });
    audit({ entityId: String(info.version), details: { rows: info.row_count } });
    return Response.json({ version: info.version, row_count: info.row_count, revision: info.revision }, { status: 201 });
  } catch {
    throw new ApiError(502, 'snapshot_failed', 'The snapshot could not be written. Contacts are unaffected. Please try again.');
  }
});
