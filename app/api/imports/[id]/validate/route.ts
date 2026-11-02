import { withAudit } from '@/lib/api/route';
import { parseJson } from '@/lib/api/errors';
import { validateBody, validateImport } from '@/lib/imports/service';

export const POST = withAudit({ action: 'import.validate', entity: 'import_batches' }, async (req, { tx, params, audit }) => {
  const body = await parseJson(req, validateBody);
  const id = params.id as string;
  const summary = await validateImport(tx, id, body);
  audit({ entityId: id, details: { total: summary.total, valid_new: summary.valid_new, valid_existing: summary.valid_existing } });
  return Response.json(summary);
});
