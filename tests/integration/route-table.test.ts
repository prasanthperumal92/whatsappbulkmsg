import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_KIND } from '@/lib/api/route';
import { isExemptApiPath } from '@/lib/auth/public-paths';
import { discoverApiRoutes, HTTP_METHODS, request, routeArgs } from '../support/routes';
import { signInAs } from '../support/clerk-mock';
import { getDb, schema } from '@/lib/db';
import { resetDb } from '../support/reset';

type Mod = Record<string, ((req: Request, args: unknown) => Promise<Response>) & { [ROUTE_KIND]?: string }>;

const handlers: { path: string; method: string; fn: Mod[string] }[] = [];
for (const route of discoverApiRoutes()) {
  const mod = (await import(/* @vite-ignore */ route.file)) as Mod;
  for (const method of HTTP_METHODS) {
    const fn = mod[method];
    if (fn) handlers.push({ path: route.path, method, fn });
  }
}

const protectedHandlers = handlers.filter((h) => !isExemptApiPath(h.path));

beforeEach(async () => {
  await resetDb();
  signInAs(null);
});

describe('route table', () => {
  it('finds the routes', () => {
    expect(handlers.map((h) => `${h.method} ${h.path}`)).toEqual(expect.arrayContaining(['GET /api/team', 'PUT /api/settings', 'GET /api/cron/ping']));
  });

  // Fails when a new route is added without a wrapper.
  it.each(handlers.map((h) => [`${h.method} ${h.path}`, h] as const))('%s uses the wrapper its path requires', (_n, h) => {
    const kind = h.fn[ROUTE_KIND];
    if (h.path.startsWith('/api/cron/')) expect(kind).toBe('cron');
    else if (h.path.startsWith('/api/webhooks/')) expect(kind).toBe('webhook');
    else if (h.method === 'GET' || h.method === 'HEAD') expect(['session', 'audited']).toContain(kind);
    else expect(kind).toBe('audited');
  });

  describe('SEC-02 no session', () => {
    it.each(protectedHandlers.map((h) => [`${h.method} ${h.path}`, h] as const))('%s returns 401', async (_n, h) => {
      const res = await h.fn(request(h.path, h.method, h.method === 'GET' ? {} : { body: {} }), routeArgs(h.path));
      expect(res.status).toBe(401);
    });
  });

  describe('FR-SET-01 signed in but not on the allowlist', () => {
    it.each(protectedHandlers.map((h) => [`${h.method} ${h.path}`, h] as const))('%s returns 403', async (_n, h) => {
      signInAs('stranger@example.com');
      const res = await h.fn(request(h.path, h.method, h.method === 'GET' ? {} : { body: {} }), routeArgs(h.path));
      expect(res.status).toBe(403);
    });
  });

  it('allowlist matching ignores email case', async () => {
    await getDb().insert(schema.teamAllowlist).values({ email: 'asha@example.com' });
    signInAs('Asha@Example.COM');
    const team = handlers.find((h) => h.path === '/api/team' && h.method === 'GET')!;
    expect((await team.fn(request('/api/team', 'GET'), routeArgs('/api/team'))).status).toBe(200);
  });
});

describe('SEC-03 cron routes', () => {
  const crons = handlers.filter((h) => h.path.startsWith('/api/cron/'));
  const call = (h: (typeof crons)[number], authorization?: string) =>
    h.fn(request(h.path, h.method, { headers: authorization ? { authorization } : {} }), routeArgs(h.path));

  it.each(crons.map((h) => [h.path, h] as const))('%s: none 401, wrong 401, correct 200', async (_n, h) => {
    process.env.CRON_SECRET = 'correct-secret';
    expect((await call(h)).status).toBe(401);
    expect((await call(h, 'Bearer wrong')).status).toBe(401);
    expect((await call(h, 'correct-secret')).status).toBe(401);
    expect((await call(h, 'Bearer correct-secret')).status).toBe(200);
  });

  it.each(crons.map((h) => [h.path, h] as const))('%s refuses everything when CRON_SECRET is unset', async (_n, h) => {
    delete process.env.CRON_SECRET;
    expect((await call(h, 'Bearer ')).status).toBe(401);
    expect((await call(h, 'Bearer undefined')).status).toBe(401);
  });
});
