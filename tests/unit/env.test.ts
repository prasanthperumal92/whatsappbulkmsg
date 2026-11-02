import { describe, expect, it } from 'vitest';
import { blobPrefix, getEnvironment, mockPolicy } from '@/lib/env';

const preview = { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feature/x y' };
const production = { VERCEL: '1', VERCEL_ENV: 'production' };

describe('T1.8 environment', () => {
  it.each([
    ['local', {}, 'local', 'dev/', { allowed: true, forced: false }],
    ['vercel dev', { VERCEL_ENV: 'development' }, 'local', 'dev/', { allowed: true, forced: false }],
    ['preview', preview, 'preview', 'preview/feature-x-y/', { allowed: true, forced: true }],
    ['production', production, 'production', 'prod/', { allowed: false, forced: false }],
    ['Vercel without VERCEL_ENV', { VERCEL: '1' }, 'production', 'prod/', { allowed: false, forced: false }],
  ])('%s', (_name, env, environment, prefix, mock) => {
    expect(getEnvironment(env)).toBe(environment);
    expect(blobPrefix(env)).toBe(prefix);
    expect(mockPolicy(env)).toEqual(mock);
  });

  it('refuses a preview with no branch name, rather than sharing a prefix', () => {
    expect(() => blobPrefix({ VERCEL_ENV: 'preview' })).toThrow();
  });

  it('a branch name cannot climb out of its prefix', () => {
    expect(blobPrefix({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: '../../prod' })).not.toContain('..');
  });
});
