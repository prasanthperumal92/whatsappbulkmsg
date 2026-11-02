import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withAudit, withSession } from '@/lib/api/route';
import { ApiError, parseJson } from '@/lib/api/errors';
import { schema } from '@/lib/db';
import { mappingProblem, STANDARD_TARGETS, type Mapping } from '@/lib/imports/mapping';

const { mappingPresets } = schema;

const target = z.union([z.enum(STANDARD_TARGETS), z.templateLiteral(['custom:', z.string().min(1)]), z.null()]);
const saveBody = z.object({ name: z.string().trim().min(1).max(100), header_signature: z.string().min(1).max(20_000), mapping: z.record(z.string().regex(/^\d+$/), target) });

const view = (p: typeof mappingPresets.$inferSelect) => ({ id: p.id, name: p.name, header_signature: p.headerSignature, mapping: p.mappingJson as Mapping });

export const GET = withSession(async (_req, { db }) => {
  const rows = await db.select().from(mappingPresets).orderBy(asc(mappingPresets.name));
  return Response.json({ items: rows.map(view) });
});

/** Presets are shared by the team (§5.3). Saving the same headers again replaces the earlier preset. */
export const POST = withAudit({ action: 'mapping_preset.save', entity: 'mapping_presets' }, async (req, { user, tx, audit }) => {
  const body = await parseJson(req, saveBody);
  const problem = mappingProblem(body.mapping as Mapping);
  if (problem) throw new ApiError(400, 'invalid_mapping', problem);
  await tx.delete(mappingPresets).where(eq(mappingPresets.headerSignature, body.header_signature));
  const [row] = await tx
    .insert(mappingPresets)
    .values({ name: body.name, headerSignature: body.header_signature, mappingJson: body.mapping, createdBy: user.id })
    .returning();
  audit({ entityId: row!.id, details: { name: body.name } });
  return Response.json(view(row!), { status: 201 });
});

export const DELETE = withAudit({ action: 'mapping_preset.delete', entity: 'mapping_presets' }, async (req, { tx, audit }) => {
  const { id } = await parseJson(req, z.object({ id: z.string().min(1) }));
  const removed = await tx.delete(mappingPresets).where(eq(mappingPresets.id, id)).returning();
  if (!removed.length) throw new ApiError(404, 'preset_not_found', 'This preset no longer exists.');
  audit({ entityId: id });
  return Response.json({ ok: true });
});
