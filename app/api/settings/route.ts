import { withAudit, withSession } from '@/lib/api/route';
import { ApiError, parseJson } from '@/lib/api/errors';
import { getSettings, SettingsValidationError, updateSettings } from '@/lib/settings/store';
import { z } from 'zod';

export const GET = withSession(async (_req, { db }) => Response.json(await getSettings(db)));

export const PUT = withAudit({ action: 'settings.update', entity: 'settings' }, async (req, { tx, audit }) => {
  const patch = await parseJson(req, z.record(z.string(), z.unknown()));
  try {
    const sections = await updateSettings(tx, patch);
    audit({ details: { sections, changes: patch } });
    return Response.json(await getSettings(tx));
  } catch (err) {
    if (err instanceof SettingsValidationError) throw new ApiError(400, 'invalid_settings', err.message);
    throw err;
  }
});
