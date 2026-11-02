import { vi } from 'vitest';
import { clerkState } from './clerk-mock';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: clerkState.userId, sessionClaims: clerkState.email ? { email: clerkState.email } : {} }),
  currentUser: async () => null,
  clerkClient: async () => ({
    invitations: {
      createInvitation: async ({ emailAddress }: { emailAddress: string }) => {
        if (clerkState.inviteError) throw clerkState.inviteError;
        clerkState.invitations.push(emailAddress);
      },
      getInvitationList: async ({ query }: { query: string }) => {
        if (clerkState.revokeError) throw clerkState.revokeError;
        return { data: clerkState.invitations.filter((e) => e === query).map((emailAddress) => ({ id: emailAddress, emailAddress })) };
      },
      revokeInvitation: async (id: string) => void clerkState.revoked.push(id),
    },
  }),
}));
