import { z } from 'zod';
import { withAudit } from '@/lib/api/route';
import { parseJson } from '@/lib/api/errors';
import { registerUpload } from '@/lib/imports/service';
import { getSettingsSection } from '@/lib/settings/store';

const body = z.object({ blob_path: z.string().min(1).max(500), file_name: z.string().trim().min(1).max(255), sha256: z.string().regex(/^[0-9a-fA-F]{64}$/) });

export const POST = withAudit({ action: 'import.register', entity: 'import_batches' }, async (req, { user, tx, audit }) => {
  const input = await parseJson(req, body);
  const { maxFileSizeMb } = await getSettingsSection(tx, 'import');
  const result = await registerUpload(tx, input, { id: user.id, email: user.email }, maxFileSizeMb * 1024 * 1024);
  audit({ entityId: result.import_id, details: { file_name: input.file_name, duplicate: !!result.duplicate_of } });
  return Response.json(result, { status: 201 });
});
