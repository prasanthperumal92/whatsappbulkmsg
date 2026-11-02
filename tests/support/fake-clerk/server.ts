import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

// Stand-in for @clerk/nextjs/server in local browser tests. See next.config.ts.
const COOKIE = 'fake_clerk_email';

const identity = (email?: string) => ({ userId: email ? `user_${email}` : null, sessionClaims: email ? { email } : {} });

export async function auth() {
  return identity((await cookies()).get(COOKIE)?.value);
}

export async function currentUser() {
  return null;
}

export async function clerkClient() {
  return {
    invitations: {
      createInvitation: async () => ({}),
      getInvitationList: async () => ({ data: [] as { id: string; emailAddress: string }[] }),
      revokeInvitation: async () => ({}),
    },
  };
}

export function createRouteMatcher(patterns: string[]) {
  const regexes = patterns.map((p) => new RegExp(`^${p}$`));
  return (req: NextRequest) => regexes.some((r) => r.test(req.nextUrl.pathname));
}

class Redirect extends Error {}

type Auth = (() => Promise<ReturnType<typeof identity>>) & { protect: () => Promise<void> };

export function clerkMiddleware(handler: (auth: Auth, req: NextRequest) => Promise<Response | void>) {
  return async (req: NextRequest) => {
    const current = identity(req.cookies.get(COOKIE)?.value);
    const authFn = (async () => current) as Auth;
    authFn.protect = async () => {
      if (!current.userId) throw new Redirect();
    };
    try {
      return (await handler(authFn, req)) ?? NextResponse.next();
    } catch (err) {
      if (err instanceof Redirect) return NextResponse.redirect(new URL('/sign-in', req.url));
      throw err;
    }
  };
}
