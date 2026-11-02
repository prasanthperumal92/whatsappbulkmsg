import { z } from 'zod';
import { withAudit } from '@/lib/api/route';
import { ApiError, parseJson } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { createSnapshot, restoreSnapshot } from '@/lib/snapshots/service';

/** §4.2: a snapshot first, on its own connection so it outlives a failed restore. No snapshot, no restore. */
export const POST = withAudit({ action: 'snapshot.restore', entity: 'contact_snapshots' }, async (req, { user, tx, params, audit }) => {
  await parseJson(req, z.object({ confirm: z.literal(true) }));
  const version = Number(params.version);
  if (!Number.isInteger(version) || version < 1) throw new ApiError(404, 'snapshot_not_found', 'This snapshot no longer exists.');

  let pre: { version: number };
  try {
    pre = await createSnapshot(getDb(), { reason: `pre-restore of ${version}`, createdBy: user.email });
  } catch {
    throw new ApiError(502, 'snapshot_failed', 'Restore cancelled: the safety snapshot could not be written. Contacts are unaffected.');
  }
  const result = await restoreSnapshot(tx, version, user.id);
  audit({ entityId: String(version), details: { restored_rows: result.restored_rows, skipped_erased: result.skipped_erased, pre_restore_snapshot: pre.version } });
  return Response.json({ ...result, pre_restore_snapshot: pre.version });
});
