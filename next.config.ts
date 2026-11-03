import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { loadLocalBin } from './lib/local-bin';

// Local browser tests only (npm run test:e2e:local): swaps Clerk for a cookie-based stand-in at compile
// time, so no production build can contain it.
export default function config(phase: string): NextConfig {
  loadLocalBin();
  const fakeClerk = process.env.E2E_FAKE_CLERK === '1';
  if (fakeClerk && (phase !== PHASE_DEVELOPMENT_SERVER || process.env.VERCEL || process.env.VERCEL_ENV)) {
    throw new Error('E2E_FAKE_CLERK is only allowed with a local `next dev`');
  }
  return {
    reactStrictMode: true,
    poweredByHeader: false,
    serverExternalPackages: ['pg'],
    // Local dev only: uploads go through the app because there is no Blob store. Deployments upload straight to Blob.
    ...(phase === PHASE_DEVELOPMENT_SERVER && { experimental: { proxyClientMaxBodySize: '60mb' } }),
    ...(fakeClerk && {
      // Its own build directory, so these tests can run beside a `next dev` you already have open.
      distDir: '.next-e2e',
      turbopack: {
        resolveAlias: {
          '@clerk/nextjs/server': './tests/support/fake-clerk/server.ts',
          '@clerk/nextjs': './tests/support/fake-clerk/client.tsx',
        },
      },
    }),
  };
}
