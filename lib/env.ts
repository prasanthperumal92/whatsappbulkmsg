// Environment detection (§3.5). Everything that varies per environment reads from here.

export type AppEnvironment = 'production' | 'preview' | 'local';
type Env = Record<string, string | undefined>;

export function getEnvironment(env: Env = process.env): AppEnvironment {
  if (env.VERCEL_ENV === 'preview') return 'preview';
  if (env.VERCEL_ENV === 'development') return 'local';
  // On Vercel without a recognised VERCEL_ENV: assume production, the mode where Mock is impossible.
  if (env.VERCEL_ENV === 'production' || env.VERCEL) return 'production';
  return 'local';
}

/** Blob path prefix (§3.4), so previews can never touch production files. */
export function blobPrefix(env: Env = process.env): string {
  switch (getEnvironment(env)) {
    case 'production':
      return 'prod/';
    case 'local':
      return 'dev/';
    case 'preview': {
      const branch = env.VERCEL_GIT_COMMIT_REF?.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '-');
      if (!branch) throw new Error('Preview deployment has no VERCEL_GIT_COMMIT_REF');
      return `preview/${branch}/`;
    }
  }
}

/** D16: Mock runs on local dev and previews, is forced on previews and is impossible in production. */
export function mockPolicy(env: Env = process.env): { allowed: boolean; forced: boolean } {
  const environment = getEnvironment(env);
  return { allowed: environment !== 'production', forced: environment === 'preview' };
}
