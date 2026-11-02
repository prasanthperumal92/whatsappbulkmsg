import type { NextConfig } from 'next';

// Local browser tests only (npm run test:e2e:local): swaps Clerk for a cookie-based stand-in at compile
// time, so a deployed build can't switch it on at runtime. Refuses to build on Vercel.
const fakeClerk = process.env.E2E_FAKE_CLERK === '1';
if (fakeClerk && (process.env.VERCEL || process.env.VERCEL_ENV)) {
  throw new Error('E2E_FAKE_CLERK must never be set on a Vercel deployment');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pg'],
  ...(fakeClerk && {
    turbopack: {
      resolveAlias: {
        '@clerk/nextjs/server': './tests/support/fake-clerk/server.ts',
        '@clerk/nextjs': './tests/support/fake-clerk/client.tsx',
      },
    },
  }),
};

export default nextConfig;
