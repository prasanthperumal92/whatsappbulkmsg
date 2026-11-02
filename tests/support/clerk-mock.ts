// Controls the Clerk session seen by route handlers (the mock itself is in clerk-mock-setup.ts).
// Real Clerk is covered by SEC-01 and HN-03 on a preview deployment.
const initial = () => ({
  userId: null as string | null,
  email: null as string | null,
  invitations: [] as string[],
  revoked: [] as string[],
  inviteError: null as Error | null,
  revokeError: null as Error | null,
});

const store = globalThis as unknown as { __clerkState?: ReturnType<typeof initial> };
export const clerkState = (store.__clerkState ??= initial());

export function signInAs(email: string | null, userId = 'user_test') {
  clerkState.userId = email ? userId : null;
  clerkState.email = email;
}

export function resetClerk() {
  Object.assign(clerkState, initial());
}
