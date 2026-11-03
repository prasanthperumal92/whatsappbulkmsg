import { and, eq, isNotNull } from 'drizzle-orm';
import { ApiError } from '@/lib/api/errors';
import { schema, type Tx } from '@/lib/db';
import type { WhatsAppProvider } from './provider';
import { templateShape, type MetaComponent, type TemplateShape } from './template-shape';

// §5.6: templates are written and approved in Meta's WhatsApp Manager, and mirrored here so a send can pick one.

const { templates } = schema;

export type TemplateRow = typeof templates.$inferSelect;
export type TemplateView = TemplateShape & {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  quality_score: string | null;
  rejected_reason: string | null;
  last_synced_at: string | null;
};

export const shapeOf = (row: TemplateRow) => templateShape({ name: row.name, language: row.language, category: row.category ?? undefined, parameter_format: row.parameterFormat ?? undefined, components: (row.componentsJson ?? []) as MetaComponent[] });

export const toTemplateView = (row: TemplateRow): TemplateView => ({
  ...shapeOf(row),
  id: row.id,
  name: row.name,
  language: row.language,
  category: row.category,
  status: row.status,
  quality_score: row.qualityScore,
  rejected_reason: row.rejectedReason,
  last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
});

export async function listTemplateViews(db: Tx) {
  const rows = await db.select().from(templates).where(and(eq(templates.channel, 'whatsapp'), isNotNull(templates.metaTemplateId)));
  return rows.map(toTemplateView).sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

/** Meta is the source of truth, so one it no longer lists goes. Past sends keep their own copy in their snapshot. */
export async function syncTemplates(tx: Tx, provider: WhatsAppProvider, now = new Date()) {
  const remote = await provider.listTemplates();
  const existing = await tx.select().from(templates).where(and(eq(templates.channel, 'whatsapp'), isNotNull(templates.metaTemplateId)));
  const byMetaId = new Map(existing.map((row) => [row.metaTemplateId!, row]));
  for (const t of remote) {
    const values = {
      name: t.name,
      language: t.language,
      category: t.category ?? null,
      status: t.status.toUpperCase(),
      parameterFormat: t.parameter_format?.toUpperCase() ?? null,
      componentsJson: t.components ?? [],
      qualityScore: t.quality_score?.score ?? null,
      rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
      lastSyncedAt: now,
    };
    const row = byMetaId.get(t.id);
    if (row) await tx.update(templates).set(values).where(eq(templates.id, row.id));
    else await tx.insert(templates).values({ ...values, channel: 'whatsapp', metaTemplateId: t.id });
  }
  const kept = new Set(remote.map((t) => t.id));
  const gone = existing.filter((row) => !kept.has(row.metaTemplateId!));
  for (const row of gone) await tx.delete(templates).where(eq(templates.id, row.id));
  return { synced: remote.length, removed: gone.length };
}

/** A template a send can use, or a reason a person can act on. */
export async function loadSendableTemplate(db: Tx, id: string): Promise<{ row: TemplateRow; shape: TemplateShape }> {
  const [row] = await db.select().from(templates).where(and(eq(templates.id, id), eq(templates.channel, 'whatsapp')));
  if (!row) throw new ApiError(404, 'template_not_found', 'This template no longer exists. Sync your templates and choose again.');
  if (row.status !== 'APPROVED') throw new ApiError(409, 'template_not_approved', `This template is ${row.status.toLowerCase()}. Meta only delivers approved templates.`);
  const shape = shapeOf(row);
  if (shape.unsupported) throw new ApiError(409, 'template_unsupported', shape.unsupported);
  return { row, shape };
}
