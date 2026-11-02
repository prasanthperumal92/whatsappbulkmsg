import { withSession } from '@/lib/api/route';
import { activeCommit } from '@/lib/imports/service';

export const GET = withSession(async (_req, { db, user }) => {
  const active = await activeCommit(db);
  return Response.json({ active: active && { ...active, mine: active.by === user.email } });
});
