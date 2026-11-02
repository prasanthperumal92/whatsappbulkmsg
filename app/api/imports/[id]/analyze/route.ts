import { withAudit } from '@/lib/api/route';
import { parseJson } from '@/lib/api/errors';
import { analyzeImport, parseOverrides } from '@/lib/imports/service';

export const POST = withAudit({ action: 'import.analyze', entity: 'import_batches' }, async (req, { tx, params, audit }) => {
  const overrides = await parseJson(req, parseOverrides);
  const id = params.id as string;
  const result = await analyzeImport(tx, id, overrides);
  audit({ entityId: id, details: { rows: result.total_rows, columns: result.columns.length } });
  return Response.json(result);
});
