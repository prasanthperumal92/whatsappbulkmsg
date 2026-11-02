import { auth, currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getDb, schema, type Tx } from '@/lib/db';

export type TeamMember = { id: string; email: string };
export type SessionState = { state: 'anonymous' } | { state: 'forbidden'; id: string; email: string | null } | { state: 'member'; user: TeamMember };

export const normaliseTeamEmail = (email: string) => email.trim().toLowerCase();

async function primaryEmail(sessionClaims: unknown): Promise<string | null> {
  // Fast path: the `email` claim added to the Clerk session token (docs/clerk-setup.md).
  const claim = (sessionClaims as { email?: unknown } | null)?.email;
  if (typeof claim === 'string' && claim) return claim;
  const user = await currentUser();
  const primary = user?.primaryEmailAddress;
  return primary?.verification?.status === 'verified' ? primary.emailAddress : null;
}

/** The allowlist decides membership on every request, so removing someone takes effect immediately. */
export async function getSessionState(db: Tx = getDb()): Promise<SessionState> {
  const { userId, sessionClaims } = await auth();
  if (!userId) return { state: 'anonymous' };
  const raw = await primaryEmail(sessionClaims);
  if (!raw) return { state: 'forbidden', id: userId, email: null };
  const email = normaliseTeamEmail(raw);
  const [row] = await db.select({ email: schema.teamAllowlist.email }).from(schema.teamAllowlist).where(eq(schema.teamAllowlist.email, email));
  return row ? { state: 'member', user: { id: userId, email } } : { state: 'forbidden', id: userId, email };
}
