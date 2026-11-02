import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@/lib/db';

const { auditLog } = schema;

export const auditQuerySchema = z.object({
  user: z.string().optional(),
  action: z.string().optional(),
  channel: z.enum(['whatsapp', 'email']).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.output<typeof auditQuerySchema>;

export async function queryAudit(db: Tx, q: AuditQuery) {
  const where: SQL[] = [];
  if (q.user) where.push(eq(auditLog.userEmail, q.user));
  if (q.action) where.push(eq(auditLog.action, q.action));
  // An action on both channels counts for either filter.
  if (q.channel) where.push(sql`${auditLog.detailsJson}->>'channel' IN (${q.channel}, 'both')`);
  if (q.from) where.push(gte(auditLog.at, new Date(q.from)));
  if (q.to) where.push(lt(auditLog.at, new Date(q.to)));
  const condition = where.length ? and(...where) : undefined;

  const [items, totals, users, actions] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(condition)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(q.page_size)
      .offset((q.page - 1) * q.page_size),
    db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(condition),
    db.selectDistinct({ v: auditLog.userEmail }).from(auditLog).orderBy(auditLog.userEmail),
    db.selectDistinct({ v: auditLog.action }).from(auditLog).orderBy(auditLog.action),
  ]);
  return {
    items,
    total: totals[0]?.n ?? 0,
    page: q.page,
    page_size: q.page_size,
    facets: { users: users.flatMap((u) => (u.v ? [u.v] : [])), actions: actions.map((a) => a.v) },
  };
}
