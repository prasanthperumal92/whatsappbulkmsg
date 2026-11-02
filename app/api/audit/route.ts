import { ApiError } from '@/lib/api/errors';
import { withSession } from '@/lib/api/route';
import { auditQuerySchema, queryAudit } from '@/lib/audit/query';

export const GET = withSession(async (req, { db }) => {
  const parsed = auditQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new ApiError(400, 'invalid_request', parsed.error.issues[0]?.message ?? 'Invalid filter');
  return Response.json(await queryAudit(db, parsed.data));
});
