import { withAudit } from '@/lib/api/route';
import { undoImport } from '@/lib/imports/service';

export const POST = withAudit({ action: 'import.undo', entity: 'import_batches' }, async (_req, { tx, params, audit }) => {
  const id = params.id as string;
  const result = await undoImport(tx, id);
  audit({ entityId: id, details: { removed_rows: result.removed_rows, restored_rows: result.restored_rows } });
  return Response.json(result);
});
