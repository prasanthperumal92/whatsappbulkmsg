import { withAudit } from '@/lib/api/route';
import { ApiError, parseJson } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { commitBody, commitImport, failBatch, getBatch, markCommitStarted, clearCommitMark } from '@/lib/imports/service';

/** A refusal leaves the batch as it was. Only a failure part-way through marks it `failed` (WP-04). */
export const POST = withAudit({ action: 'import.commit', entity: 'import_batches' }, async (req, { user, tx, params, audit, afterRollback }) => {
  const id = params.id as string;
  const body = await parseJson(req, commitBody);
  await getBatch(tx, id);

  const db = getDb();
  await markCommitStarted(db, id, user.email);
  let refused = false;
  afterRollback(async (afterDb) => {
    if (refused) await clearCommitMark(afterDb, id);
    else await failBatch(afterDb, id);
  });
  try {
    const result = await commitImport(tx, id, body, { id: user.id, email: user.email });
    audit({ entityId: id, details: { new_rows: result.new_rows, updated_rows: result.updated_rows, policy: body.policy ?? null } });
    return Response.json(result);
  } catch (err) {
    refused = err instanceof ApiError;
    throw err;
  }
});
