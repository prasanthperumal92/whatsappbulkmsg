import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clerkState, resetClerk, signInAs } from '../support/clerk-mock';
import { withAudit, writeAudit } from '@/lib/api/route';
import { getDb, schema } from '@/lib/db';
import { request, routeArgs } from '../support/routes';
import { resetDb } from '../support/reset';
import * as team from '@/app/api/team/route';
import * as settingsRoute from '@/app/api/settings/route';
import * as auditRoute from '@/app/api/audit/route';
import { ApiError } from '@/lib/api/errors';

const db = getDb();
const { auditLog, teamAllowlist, settings } = schema;
const ME = 'asha@example.com';

const noParams = routeArgs('/x');
const auditRows = () => db.select().from(auditLog);

beforeEach(async () => {
  await resetDb();
  resetClerk();
  await db.insert(teamAllowlist).values({ email: ME });
  signInAs(ME, 'user_asha');
});

describe('AU-01 every state-changing route writes exactly one audit row', () => {
  // Extend this table as routes are added. The route-table test forces them through withAudit.
  it.each([
    ['POST /team', 'team.add', 'team_allowlist', () => team.POST(request('/api/team', 'POST', { body: { email: 'ravi@example.com' } }), noParams)],
    ['PUT /settings', 'settings.update', 'settings', () => settingsRoute.PUT(request('/api/settings', 'PUT', { body: { import: { maxFileSizeMb: 10 } } }), noParams)],
  ])('%s', async (_n, action, entity, call) => {
    const res = await call();
    expect(res.status).toBeLessThan(300);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'user_asha', userEmail: ME, action, entity });
  });

  it('DELETE /team', async () => {
    await db.insert(teamAllowlist).values({ email: 'ravi@example.com' });
    const res = await team.DELETE(request('/api/team', 'DELETE', { body: { email: 'ravi@example.com' } }), noParams);
    expect(res.status).toBe(200);
    expect(await auditRows()).toMatchObject([{ action: 'team.remove', entityId: 'ravi@example.com', userEmail: ME }]);
  });
});

describe('withAudit transaction', () => {
  it('rolls back the change and writes no audit row when the handler throws', async () => {
    const route = withAudit({ action: 't', entity: 't' }, async (_r, { tx }) => {
      await tx.insert(teamAllowlist).values({ email: 'x@example.com' });
      throw new ApiError(409, 'nope', 'Nope');
    });
    const res = await route(request('/x', 'POST'), noParams);
    expect(res.status).toBe(409);
    expect(await auditRows()).toHaveLength(0);
    expect(await db.select().from(teamAllowlist).where(eq(teamAllowlist.email, 'x@example.com'))).toHaveLength(0);
  });

  it('rolls back on a non-2xx response', async () => {
    const route = withAudit({ action: 't', entity: 't' }, async (_r, { tx }) => {
      await tx.insert(teamAllowlist).values({ email: 'x@example.com' });
      return Response.json({}, { status: 422 });
    });
    expect((await route(request('/x', 'POST'), noParams)).status).toBe(422);
    expect(await auditRows()).toHaveLength(0);
    expect(await db.select().from(teamAllowlist).where(eq(teamAllowlist.email, 'x@example.com'))).toHaveLength(0);
  });

  it('never exposes an unexpected error to the caller', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const route = withAudit({ action: 't', entity: 't' }, async () => {
      throw new Error('postgres://user:hunter2@host failed for +919876543210');
    });
    const res = await route(request('/x', 'POST'), noParams);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('hunter2');
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('919876543210');
    spy.mockRestore();
  });

  it('scrubs secrets and masks people in audit details', async () => {
    const route = withAudit({ action: 't', entity: 't' }, async (_r, { audit }) => {
      audit({ details: { access_token: 'EAAabcdefghijklmnop', note: 'key re_abcdefgh for +919876543210 and asha@example.com' } });
      return Response.json({});
    });
    await route(request('/x', 'POST'), noParams);
    const text = JSON.stringify(await auditRows());
    for (const leak of ['EAAabcdefghijklmnop', 're_abcdefgh', '919876543210', 'asha@example.com,']) expect(text).not.toContain(leak);
    expect(text).toContain('+91******3210');
  });
});

describe('T1.5 team allowlist', () => {
  const post = (email: string) => team.POST(request('/api/team', 'POST', { body: { email } }), noParams);
  const del = (email: string) => team.DELETE(request('/api/team', 'DELETE', { body: { email } }), noParams);

  it('adds a normalised email and sends a Clerk invitation', async () => {
    expect((await post(' Ravi@Example.com ')).status).toBe(201);
    expect(clerkState.invitations).toEqual(['ravi@example.com']);
    expect(await db.select().from(teamAllowlist).where(eq(teamAllowlist.email, 'ravi@example.com'))).toHaveLength(1);
  });

  it('refuses a duplicate with 409 and no audit row', async () => {
    expect((await post(ME)).status).toBe(409);
    expect(await auditRows()).toHaveLength(0);
  });

  it('rolls back the allowlist entry when Clerk refuses the invitation', async () => {
    clerkState.inviteError = new Error('Clerk down');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post('ravi@example.com')).status).toBe(502);
    spy.mockRestore();
    expect(await db.select().from(teamAllowlist).where(eq(teamAllowlist.email, 'ravi@example.com'))).toHaveLength(0);
  });

  it('removal revokes access on the next request, and a pending invitation', async () => {
    await post('ravi@example.com');
    expect((await del('ravi@example.com')).status).toBe(200);
    expect(clerkState.revoked).toEqual(['ravi@example.com']);
    signInAs('ravi@example.com', 'user_ravi');
    expect((await team.GET(request('/api/team', 'GET'), noParams)).status).toBe(403);
  });

  it('a Clerk outage does not block removal', async () => {
    await db.insert(teamAllowlist).values({ email: 'ravi@example.com' });
    clerkState.revokeError = new Error('Clerk down');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await del('ravi@example.com')).status).toBe(200);
    spy.mockRestore();
  });

  it('refuses to remove the last member', async () => {
    const res = await del(ME);
    expect(res.status).toBe(409);
    expect(await db.select().from(teamAllowlist)).toHaveLength(1);
  });

  it('simultaneous removals cannot empty the list', async () => {
    await db.insert(teamAllowlist).values({ email: 'ravi@example.com' });
    const results = await Promise.all([del(ME), del('ravi@example.com')]);
    // The loser gets 409 (last member), or 403 if the winner's removal took away the caller's own access first.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect(await db.select().from(teamAllowlist)).toHaveLength(1);
  });

  it('returns 404 for someone not on the list, and 400 for a bad email', async () => {
    await db.insert(teamAllowlist).values({ email: 'ravi@example.com' });
    expect((await del('nobody@example.com')).status).toBe(404);
    expect((await post('not-an-email')).status).toBe(400);
  });
});

describe('GET /audit', () => {
  const get = async (query = '') => (await auditRoute.GET(request(`/api/audit${query}`, 'GET'), noParams)).json();

  beforeEach(async () => {
    const asha = { id: 'u1', email: 'asha@example.com' };
    const ravi = { id: 'u2', email: 'ravi@example.com' };
    await writeAudit(db, asha, 'campaign.start', 'campaign', { channel: 'whatsapp' });
    await writeAudit(db, ravi, 'campaign.start', 'campaign', { channel: 'email' });
    await writeAudit(db, ravi, 'import.commit', 'import', { channel: 'both' });
    await writeAudit(db, asha, 'team.add', 'team_allowlist');
  });

  it('returns newest first with totals and filter options', async () => {
    const body = await get();
    expect(body.total).toBe(4);
    const times = body.items.map((i: { at: string }) => i.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(body.facets.users).toEqual(['asha@example.com', 'ravi@example.com']);
    expect(body.facets.actions).toContain('team.add');
  });

  it.each([
    ['?user=ravi@example.com', 2],
    ['?action=campaign.start', 2],
    ['?channel=email', 2],
    ['?channel=whatsapp', 2],
    ['?channel=whatsapp&user=asha@example.com', 1],
    ['?from=2999-01-01T00:00:00Z', 0],
    ['?to=2999-01-01T00:00:00Z', 4],
  ])('filters %s', async (query, count) => {
    expect((await get(query)).total).toBe(count);
  });

  it('pages', async () => {
    const body = await get('?page=2&page_size=3');
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(4);
  });

  it('rejects a bad filter', async () => {
    const res = await auditRoute.GET(request('/api/audit?channel=sms', 'GET'), noParams);
    expect(res.status).toBe(400);
  });
});

describe('T1.8 /settings', () => {
  const put = (body: unknown) => settingsRoute.PUT(request('/api/settings', 'PUT', { body }), noParams);
  const get = async () => (await settingsRoute.GET(request('/api/settings', 'GET'), noParams)).json();

  it('returns defaults on an empty database', async () => {
    expect((await get()).whatsappSending.messagesPerSecond).toBe(20);
  });

  it('merges a partial update and keeps other fields', async () => {
    expect((await put({ whatsappSending: { messagesPerSecond: 40 } })).status).toBe(200);
    const body = await get();
    expect(body.whatsappSending.messagesPerSecond).toBe(40);
    expect(body.whatsappSending.frequencyCapDays).toBe(7);
  });

  it.each([
    ['out of range', { whatsappSending: { messagesPerSecond: 81 } }],
    ['unknown field', { whatsapp: { accessToken: 'EAAabcdefghijklmnop' } }],
    ['unknown section', { secrets: { RESEND_API_KEY: 're_abcdefgh' } }],
  ])('refuses %s with no change and no audit row', async (_n, patch) => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await put(patch)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(await db.select().from(settings)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('applies nothing when one of several sections is invalid', async () => {
    expect((await put({ import: { maxFileSizeMb: 10 }, whatsappSending: { messagesPerSecond: 81 } })).status).toBe(400);
    expect((await get()).import.maxFileSizeMb).toBe(50);
  });

  it('never lets the provider change away from local dev', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect((await put({ whatsapp: { provider: 'graph' } })).status).toBe(400);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await put({ email: { provider: 'mock' } })).status).toBe(400);
    vi.unstubAllEnvs();
    expect((await put({ email: { provider: 'resend' } })).status).toBe(200);
  });
});
