import { z } from 'zod';
import { withAudit, withSession } from '@/lib/api/route';
import { ApiError, parseJson } from '@/lib/api/errors';
import { scrubString } from '@/lib/log';
import { CHANNELS, type Channel } from '@/lib/db/schema';
import { getSettingsSection } from '@/lib/settings/store';
import { addSuppression, listSuppressions, normaliseIdentifier, removeSuppression } from '@/lib/suppression/service';

function channelOf(req: Request): Channel {
  const value = new URL(req.url).searchParams.get('channel') ?? 'whatsapp';
  if (!(CHANNELS as readonly string[]).includes(value)) throw new ApiError(400, 'invalid_channel', 'channel must be whatsapp or email');
  return value as Channel;
}

async function identifierOf(tx: Parameters<typeof getSettingsSection>[0], channel: Channel, raw: string) {
  const { defaultCountry } = await getSettingsSection(tx, 'import');
  const identifier = normaliseIdentifier(channel, raw, defaultCountry);
  if (!identifier) throw new ApiError(400, 'invalid_identifier', channel === 'email' ? 'This is not a valid email address.' : 'This is not a valid phone number.');
  return identifier;
}

export const GET = withSession(async (req, { db }) => Response.json({ items: await listSuppressions(db, channelOf(req)) }));

export const POST = withAudit({ action: 'suppression.add', entity: 'suppression' }, async (req, { user, tx, audit }) => {
  const channel = channelOf(req);
  const { identifier: raw, source } = await parseJson(req, z.object({ identifier: z.string().trim().min(1), source: z.string().max(200).optional() }));
  const identifier = await identifierOf(tx, channel, raw);
  await addSuppression(tx, { channel, identifier, reason: 'manual', source: source ?? null, createdBy: user.id });
  audit({ entityId: scrubString(identifier), channel });
  return Response.json({ identifier, channel }, { status: 201 });
});

/** AU-02: a reason is required, and is audited. */
export const DELETE = withAudit({ action: 'suppression.remove', entity: 'suppression' }, async (req, { tx, audit }) => {
  const channel = channelOf(req);
  const { identifier: raw, reason } = await parseJson(req, z.object({ identifier: z.string().trim().min(1), reason: z.string().trim().min(1).max(500) }));
  const identifier = await identifierOf(tx, channel, raw);
  if (!(await removeSuppression(tx, channel, identifier))) throw new ApiError(404, 'not_suppressed', 'This entry is not on the suppression list.');
  audit({ entityId: scrubString(identifier), channel, details: { reason } });
  return Response.json({ ok: true });
});
