import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withAudit, withSession } from '@/lib/api/route';
import { ApiError, parseJson } from '@/lib/api/errors';
import { inviteToClerk, revokePendingInvitation } from '@/lib/auth/invitations';
import { schema } from '@/lib/db';

const { teamAllowlist } = schema;
const body = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });

export const GET = withSession(async (_req, { db }) => {
  const items = await db.select().from(teamAllowlist).orderBy(asc(teamAllowlist.email));
  return Response.json({ items });
});

export const POST = withAudit({ action: 'team.add', entity: 'team_allowlist' }, async (req, { user, tx, audit }) => {
  const { email } = await parseJson(req, body);
  const [row] = await tx.insert(teamAllowlist).values({ email, addedBy: user.email }).onConflictDoNothing().returning();
  if (!row) throw new ApiError(409, 'already_on_allowlist', `${email} is already on the team`);
  await inviteToClerk(email);
  audit({ entityId: email });
  return Response.json(row, { status: 201 });
});

export const DELETE = withAudit({ action: 'team.remove', entity: 'team_allowlist' }, async (req, { tx, audit }) => {
  const { email } = await parseJson(req, body);
  // Lock the list so two simultaneous removals can't empty it.
  const rows = await tx.select().from(teamAllowlist).for('update');
  if (!rows.some((r) => r.email === email)) throw new ApiError(404, 'not_on_allowlist', `${email} is not on the team`);
  if (rows.length === 1) throw new ApiError(409, 'last_member', 'The last team member cannot be removed');
  await tx.delete(teamAllowlist).where(eq(teamAllowlist.email, email));
  await revokePendingInvitation(email);
  audit({ entityId: email });
  return Response.json({ ok: true });
});
