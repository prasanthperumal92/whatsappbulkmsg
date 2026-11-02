import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { PUBLIC_ROUTE_PATTERNS, SIGN_IN_PATH } from '@/lib/auth/public-paths';

const isPublic = createRouteMatcher(PUBLIC_ROUTE_PATTERNS);
const isApi = createRouteMatcher(['/api(.*)']);

// First line of defence. Route wrappers and the (app) layout also check, and they check the allowlist.
export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return;
  if (isApi(req)) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, { status: 401 });
    return;
  }
  await auth.protect();
}, { signInUrl: SIGN_IN_PATH });

export const config = {
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)', '/(api)(.*)'],
};
