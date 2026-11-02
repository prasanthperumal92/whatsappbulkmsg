import { clerkClient } from '@clerk/nextjs/server';
import { log } from '@/lib/log';

// The Clerk instance is in Restricted sign-up mode (docs/clerk-setup.md): only invited emails can
// create an account. `team_allowlist` remains the authority; this just opens the door for new members.

export async function inviteToClerk(email: string) {
  const clerk = await clerkClient();
  await clerk.invitations.createInvitation({ emailAddress: email, ignoreExisting: true });
}

/** Best effort: the allowlist already refuses this person, so a Clerk outage must not block removal. */
export async function revokePendingInvitation(email: string) {
  try {
    const clerk = await clerkClient();
    const { data } = await clerk.invitations.getInvitationList({ status: 'pending', query: email });
    await Promise.all(data.filter((i) => i.emailAddress.toLowerCase() === email).map((i) => clerk.invitations.revokeInvitation(i.id)));
  } catch (err) {
    log.warn('Could not revoke a pending Clerk invitation', { email, err });
  }
}
