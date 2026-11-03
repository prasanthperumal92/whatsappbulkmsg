import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Webhook } from 'svix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as campaignsRoute from '@/app/api/campaigns/route';
import * as campaignRoute from '@/app/api/campaigns/[id]/route';
import * as campaignMessagesRoute from '@/app/api/campaigns/[id]/messages/route';
import * as campaignFailuresRoute from '@/app/api/campaigns/[id]/failures/route';
import * as webhookStatusRoute from '@/app/api/settings/email-webhook/route';
import * as contactsRoute from '@/app/api/contacts/route';
import * as previewRoute from '@/app/api/emails/preview/route';
import * as sendRoute from '@/app/api/emails/send/route';
import * as testRoute from '@/app/api/emails/test/route';
import * as settingsRoute from '@/app/api/settings/route';
import * as credentialsRoute from '@/app/api/settings/credentials/route';
import * as webhookRoute from '@/app/api/webhooks/resend/route';
import * as unsubscribeRoute from '@/app/u/[token]/route';
import { getDb, schema } from '@/lib/db';
import { resolveAudience } from '@/lib/email/audience';
import { EmailProviderError, type EmailProvider } from '@/lib/email/provider';
import { createEmailSend, emailSettingsFrom, runEmailSend } from '@/lib/email/send';
import { signTestToken, signToken } from '@/lib/email/unsubscribe';
import { getSecret } from '@/lib/settings/secrets';
import { getSettings, updateSettings } from '@/lib/settings/store';
import { addSuppression } from '@/lib/suppression/service';
import { resetClerk, signInAs } from '../support/clerk-mock';
import { resetDb } from '../support/reset';
import { request, routeArgs } from '../support/routes';

const db = getDb();
const { auditLog, campaigns, campaignMessages, contactActivity, emailLinkClicks, emailSuppressionList, teamAllowlist, webhookEvents } = schema;
const ME = 'asha.member@example.com';
const SECRET = 'unsubscribe-test-secret';
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const SEND = { subject: 'Hello {{first_name}}', body: 'Our offer is live.' };

const call = (mod: { POST: (req: Request, args: never) => Promise<Response> }, path: string, body: unknown) => mod.POST(request(path, 'POST', { body }), routeArgs(path) as never);
const addContact = async (fields: Record<string, unknown>) => {
  const res = await call(contactsRoute, '/api/contacts', { email_consent_confirmed: true, ...fields });
  expect(res.status).toBe(201);
  return (await res.json()).contact_id as string;
};
const preview = async (ids: string[], include_unknown = false) => (await call(previewRoute, '/api/emails/preview', { selection: { mode: 'ids', ids }, include_unknown })).json();
const send = (ids: string[], extra: Record<string, unknown> = {}) => call(sendRoute, '/api/emails/send', { selection: { mode: 'ids', ids }, expected_recipients: ids.length, ...SEND, ...extra });
const configure = () =>
  updateSettings(db, { email: { fromName: 'Grace Ferro', fromAddress: 'offers@mail.example.com', postalAddress: '12 Harbour Road, Kochi', signature: 'Regards, Asha' } });
const messages = () => db.select().from(campaignMessages);

beforeEach(async () => {
  await resetDb();
  resetClerk();
  vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', SECRET);
  vi.stubEnv('APP_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('RESEND_API_KEY', '');
  vi.stubEnv('RESEND_WEBHOOK_SECRET', WEBHOOK_SECRET);
  await db.insert(teamAllowlist).values({ email: ME });
  signInAs(ME, 'user_asha');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/contacts', () => {
  const list = async (query: string) => (await contactsRoute.GET(request(`/api/contacts?${query}`, 'GET'), routeArgs('/api/contacts'))).json();

  it('pages newest first and searches name, phone and email, treating % as text', async () => {
    await addContact({ email: 'one@example.com', first_name: 'Asha', last_name: 'Rao' });
    await addContact({ email: 'two@example.com', first_name: 'Ravi' });
    await addContact({ phone: '+919876543210', first_name: '100%' });

    const first = await list('page=1&page_size=2');
    expect(first.total).toBe(3);
    expect(first.items.map((c: { first_name: string }) => c.first_name)).toEqual(['100%', 'Ravi']);
    expect((await list('page=2&page_size=2')).items).toHaveLength(1);

    expect((await list('q=asha rao')).total).toBe(1);
    expect((await list('q=two@')).total).toBe(1);
    expect((await list('q=98765')).total).toBe(1);
    expect((await list(`q=${encodeURIComponent('%')}`)).items.map((c: { first_name: string }) => c.first_name)).toEqual(['100%']);
  });

  it('refuses a bad page', async () => {
    expect((await contactsRoute.GET(request('/api/contacts?page=0', 'GET'), routeArgs('/api/contacts'))).status).toBe(400);
  });
});

describe('POST /api/emails/preview', () => {
  it('lists what blocks sending until Settings are complete', async () => {
    const id = await addContact({ email: 'a@example.com' });
    const before = await preview([id]);
    expect(before.recipients).toBe(1);
    expect(before.problems.join(' ')).toMatch(/from name/);
    expect(before.problems.join(' ')).toMatch(/business address/);
    await configure();
    expect((await preview([id])).problems).toEqual([]);
  });

  it('blocks a send over the daily cap, without trimming it silently', async () => {
    await configure();
    await updateSettings(db, { emailSending: { dailyCap: 1 } });
    const ids = [await addContact({ email: 'a@example.com' }), await addContact({ email: 'b@example.com' })];
    expect((await preview(ids)).problems.join(' ')).toMatch(/limited to 1 more email by today's send cap/);
    const res = await send(ids);
    expect(res.status).toBe(409);
    expect(await messages()).toHaveLength(0);
  });

  it('warns about role addresses', async () => {
    await configure();
    expect((await preview([await addContact({ email: 'info@example.com' })])).warnings.join(' ')).toMatch(/role address/);
  });
});

describe('POST /api/emails/send (Mock provider)', () => {
  it('sends to consenting contacts only, records everything, and audits it', async () => {
    await configure();
    const yes = await addContact({ email: 'yes@example.com', first_name: 'Asha' });
    const unknown = await addContact({ email: 'unknown@example.com', email_consent_confirmed: false });
    const noEmail = await addContact({ phone: '+919876543210', email_consent_confirmed: false });

    const res = await send([yes, unknown, noEmail], { expected_recipients: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1, failed: 0, skipped: 0, stopped_reason: null });

    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contactId: yes, emailTo: 'yes@example.com', channel: 'email', status: 'accepted' });
    expect(rows[0]!.resendId).toBeTruthy();
    expect(rows[0]!.batchKey).toMatch(/^cmp_.+_b_.+/);

    const [campaign] = await db.select().from(campaigns);
    expect(campaign).toMatchObject({ channel: 'email', status: 'completed', total: 1, name: SEND.subject });
    const [activity] = await db.select().from(contactActivity).where(eq(contactActivity.contactId, yes));
    expect(activity).toMatchObject({ totalEmails: 1, lastEmailCampaignId: campaign!.id });
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'email.send'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detailsJson).toMatchObject({ selected: 3, recipients: 1, accepted: 1, excluded: { unknown_consent: 1, no_email: 1 } });
    expect(JSON.stringify(audits[0]!.detailsJson)).not.toContain('yes@example.com');
  });

  it('refuses a stale count, so nobody sends to an audience they did not see', async () => {
    await configure();
    const res = await send([await addContact({ email: 'a@example.com' })], { expected_recipients: 5 });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('audience_changed');
    expect(await db.select().from(campaigns)).toHaveLength(0);
  });

  it('D15 needs the typed acknowledgement to include unknown consent', async () => {
    await configure();
    const id = await addContact({ email: 'u@example.com', phone: '+919876543210', email_consent_confirmed: false });
    expect((await send([id], { include_unknown: true })).status).toBe(400);
    expect((await send([id], { include_unknown: true, unknown_ack: 'INCLUDE' })).status).toBe(200);
    const [campaign] = await db.select().from(campaigns);
    expect(campaign).toMatchObject({ includeUnknown: true, includeUnknownAckBy: 'user_asha' });
  });

  it('honours "select all matching" with exclusions', async () => {
    await configure();
    const a = await addContact({ email: 'a@steel.example.com' });
    await addContact({ email: 'b@steel.example.com' });
    await addContact({ email: 'c@other.example.com' });
    const res = await call(sendRoute, '/api/emails/send', { selection: { mode: 'filter', q: 'steel', exclude_ids: [a] }, expected_recipients: 1, ...SEND });
    expect(res.status).toBe(200);
    expect((await messages()).map((m) => m.emailTo)).toEqual(['b@steel.example.com']);
  });

  it('the frequency cap stops a second send to the same person', async () => {
    await configure();
    const id = await addContact({ email: 'a@example.com' });
    expect((await send([id])).status).toBe(200);
    expect((await preview([id])).excluded.frequency_cap).toBe(1);
  });

  it('skips a contact missing a variable, and refuses an unknown variable', async () => {
    await configure();
    const id = await addContact({ email: 'a@example.com' });
    expect((await send([id], { body: 'Hi {{nickname}}' })).status).toBe(400);
    const res = await send([id], { body: 'Hi {{company}}' });
    expect(await res.json()).toMatchObject({ accepted: 0, skipped: 1 });
    expect((await messages())[0]).toMatchObject({ status: 'skipped', errorCode: 'EMPTY_VARIABLE' });
  });

  it('refuses an empty subject, and a subject with a line break', async () => {
    await configure();
    const id = await addContact({ email: 'a@example.com' });
    expect((await send([id], { subject: '  ' })).status).toBe(400);
    expect((await send([id], { subject: 'a\nBcc: x@example.com' })).status).toBe(400);
  });

  it('§8.7 one send at a time, and a dead send stops holding the channel', async () => {
    await configure();
    const id = await addContact({ email: 'a@example.com' });
    const [held] = await db.insert(campaigns).values({ channel: 'email', name: 'Held', status: 'running', heartbeatAt: new Date() }).returning();
    const res = await send([id]);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('send_in_progress');

    await db.update(campaigns).set({ heartbeatAt: new Date(Date.now() - 20 * 60 * 1000) }).where(eq(campaigns.id, held!.id));
    expect((await send([id])).status).toBe(200);
    expect((await db.select().from(campaigns).where(eq(campaigns.id, held!.id)))[0]!.status).toBe('failed');
  });
});

describe('POST /api/emails/send (Resend, HTTP stubbed)', () => {
  it('sends the rendered email through the batch endpoint', async () => {
    await configure();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'resend-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await send([await addContact({ email: 'a@example.com', first_name: 'Asha' })]);
    expect(await res.json()).toMatchObject({ accepted: 1 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails/batch');
    const [sent] = JSON.parse(init.body as string);
    const [row] = await messages();
    expect(sent.subject).toBe('Hello Asha');
    expect(sent.from).toBe('"Grace Ferro" <offers@mail.example.com>');
    expect(sent.html).toContain('Regards, Asha');
    expect(sent.html).toContain('12 Harbour Road, Kochi');
    expect(sent.headers['List-Unsubscribe']).toBe(`<http://localhost/u/${signToken(row!.id, SECRET)}>`);
    expect(sent.tags).toEqual(expect.arrayContaining([{ name: 'message_id', value: row!.id }]));
    expect(row).toMatchObject({ resendId: 'resend-1', status: 'accepted' });
  });

  it('warns that links point at localhost when sending for real from local dev', async () => {
    await configure();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    expect((await preview([await addContact({ email: 'a@example.com' })])).warnings.join(' ')).toMatch(/localhost/);
  });

  it('a refused key stops the send, and the error reaches the user', async () => {
    await configure();
    vi.stubEnv('RESEND_API_KEY', 're_bad');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'invalid_api_key', message: 'API key is invalid', statusCode: 401 }), { status: 401 })));
    const res = await send([await addContact({ email: 'a@example.com' })]);
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary).toMatchObject({ accepted: 0, failed: 1 });
    expect(summary.stopped_reason).toMatch(/API key/);
    expect((await db.select().from(campaigns))[0]!.status).toBe('failed');
    expect((await messages())[0]).toMatchObject({ status: 'failed', errorCode: 'invalid_api_key', errorDetail: 'API key is invalid' });
  });
});

describe('§7A.7 runEmailSend', () => {
  const noSleep = async () => {};
  async function prepare(addresses: string[]) {
    await configure();
    const ids = [];
    for (const email of addresses) ids.push(await addContact({ email }));
    const settings = await getSettings(db);
    const plan = await resolveAudience(db, { mode: 'ids', ids }, settings, false);
    return createEmailSend(db, { composition: SEND, plan, settings: emailSettingsFrom(settings, 'https://wa.example.com'), user: { id: 'user_asha' }, includeUnknown: false });
  }
  const provider = (over: Partial<EmailProvider>): EmailProvider => ({
    kind: 'resend',
    sendBatch: async (emails) => emails.map((_, i) => `id-${i}`),
    sendOne: async () => 'solo',
    ...over,
  });
  const run = (id: string, p: EmailProvider) => runEmailSend(db, id, p, { secret: SECRET, sleep: noSleep });

  it('sends in batches of 100, committing rows before each call', async () => {
    const id = await prepare(Array.from({ length: 101 }, (_, i) => `c${i}@example.com`));
    const sizes: number[] = [];
    let keys = new Set<string>();
    const summary = await run(id, provider({
      sendBatch: async (emails, key) => {
        sizes.push(emails.length);
        keys = keys.add(key);
        // Visible on another connection already, so a very fast webhook or unsubscribe finds it.
        const inFlight = (await messages()).filter((m) => m.status === 'sending');
        expect(inFlight).toHaveLength(emails.length);
        return emails.map((e) => e.to[0]);
      },
    }));
    expect(sizes).toEqual([100, 1]);
    expect(keys.size).toBe(2);
    expect(summary).toMatchObject({ accepted: 101, failed: 0 });
    expect((await messages()).every((m) => m.resendId === m.emailTo)).toBe(true); // Ids map back by index.
  });

  it('retries a 5xx with the same key, then succeeds', async () => {
    const id = await prepare(['a@example.com']);
    const keys: string[] = [];
    const summary = await run(id, provider({
      sendBatch: async (emails, key) => {
        keys.push(key);
        if (keys.length < 3) throw new EmailProviderError(500, 'internal_server_error', 'oops');
        return emails.map(() => 'ok');
      },
    }));
    expect(summary).toMatchObject({ accepted: 1 });
    expect(new Set(keys).size).toBe(1);
    expect(keys).toHaveLength(3);
  });

  it('after the retries run out, in-flight rows are unknown and the rest are left unsent', async () => {
    const id = await prepare(Array.from({ length: 101 }, (_, i) => `c${i}@example.com`));
    const send = vi.fn(async () => { throw new EmailProviderError(null, 'application_error', 'no network'); });
    const summary = await run(id, provider({ sendBatch: send }));
    expect(send).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ accepted: 0, unknown: 100, skipped: 1 });
    expect(summary.stopped_reason).toMatch(/may have gone out/);
  });

  it('splits a batch Resend refused, so one bad row cannot sink the others', async () => {
    const id = await prepare(['good@example.com', 'bad@example.com']);
    const keys: (string | undefined)[] = [];
    const summary = await run(id, provider({
      sendBatch: async () => { throw new EmailProviderError(422, 'validation_error', 'Invalid `to` field'); },
      sendOne: async (email, key) => {
        keys.push(key);
        if (email.to[0] === 'bad@example.com') throw new EmailProviderError(422, 'validation_error', 'Invalid `to` field');
        return 'solo';
      },
    }));
    expect(summary).toMatchObject({ accepted: 1, failed: 1, stopped_reason: null });
    expect(keys.every((k) => k?.startsWith('msg_'))).toBe(true);
    const bad = (await messages()).find((m) => m.emailTo === 'bad@example.com');
    expect(bad).toMatchObject({ status: 'failed', errorCode: 'validation_error' });
  });

  it('an unverified domain stops at once instead of trying every row', async () => {
    const id = await prepare(['a@example.com', 'b@example.com']);
    const one = vi.fn(async () => 'solo');
    const summary = await run(id, provider({
      sendBatch: async () => { throw new EmailProviderError(403, 'validation_error', 'The mail.example.com domain is not verified'); },
      sendOne: one,
    }));
    expect(one).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ accepted: 0, failed: 2 });
    expect(summary.stopped_reason).toMatch(/not verified/);
  });

  it('checks suppression again just before sending', async () => {
    const id = await prepare(['gone@example.com', 'here@example.com']);
    await db.transaction((tx) => addSuppression(tx, { channel: 'email', identifier: 'gone@example.com', reason: 'manual' }));
    const seen: string[] = [];
    const summary = await run(id, provider({ sendBatch: async (emails) => emails.map((e) => (seen.push(e.to[0]), 'x')) }));
    expect(seen).toEqual(['here@example.com']);
    expect(summary).toMatchObject({ accepted: 1, skipped: 1 });
  });

  it('ES-27 saving the id does not lower a status a webhook already set', async () => {
    const id = await prepare(['a@example.com']);
    await run(id, provider({
      sendBatch: async (emails) => {
        await db.update(campaignMessages).set({ status: 'delivered' }).where(eq(campaignMessages.emailTo, 'a@example.com'));
        return emails.map(() => 'r1');
      },
    }));
    expect((await messages())[0]).toMatchObject({ status: 'delivered', resendId: 'r1' });
  });
});

describe('POST /api/emails/test', () => {
  it('goes to the person sending, marked as a test, and creates no message rows', async () => {
    await configure();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'test-1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(testRoute, '/api/emails/test', SEND);
    expect(res.status).toBe(200);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.to).toEqual([ME]);
    expect(body.subject).toBe('[TEST] Hello Asha');
    expect(await messages()).toHaveLength(0);
  });

  it('reports a Resend refusal', async () => {
    await configure();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'validation_error', message: 'Domain not verified', statusCode: 403 }), { status: 403 })));
    const res = await call(testRoute, '/api/emails/test', SEND);
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/Domain not verified/);
  });
});

describe('§5.13 unsubscribe', () => {
  const args = (token: string) => ({ params: Promise.resolve({ token }) });
  const get = (token: string) => unsubscribeRoute.GET(new Request(`http://localhost/u/${token}`), args(token));
  const post = (token: string, body = '') => unsubscribeRoute.POST(new Request(`http://localhost/u/${token}`, { method: 'POST', body }), args(token));

  async function sentMessage() {
    await configure();
    await send([await addContact({ email: 'asha@example.com' })]);
    const [row] = await messages();
    return { row: row!, token: signToken(row!.id, SECRET) };
  }

  it('GET shows the masked address and writes nothing', async () => {
    const { token } = await sentMessage();
    const res = await get(token);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('a••••@example.com');
    expect(html).toContain('Grace Ferro');
    expect(html).not.toContain('asha@example.com');
    expect(await db.select().from(emailSuppressionList)).toHaveLength(0);
  });

  it('POST suppresses the address, opts the contact out, audits once, and can be repeated', async () => {
    const { token, row } = await sentMessage();
    expect((await post(token)).status).toBe(200);
    expect((await post(token)).status).toBe(200);
    const [entry] = await db.select().from(emailSuppressionList);
    expect(entry).toMatchObject({ email: 'asha@example.com', reason: 'unsubscribe_link', source: row.campaignId });
    expect((await messages())[0]!.unsubscribedAt).toBeTruthy();
    const [contact] = await db.select().from(schema.contacts);
    expect(contact!.emailOptInStatus).toBe('opted_out');
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'email.unsubscribe'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe('system:unsubscribe');
  });

  it('RFC 8058 records a one-click unsubscribe', async () => {
    const { token } = await sentMessage();
    await post(token, 'List-Unsubscribe=One-Click');
    expect((await db.select().from(emailSuppressionList))[0]!.reason).toBe('one_click');
  });

  it('a tampered token writes nothing and shows the generic page', async () => {
    const { token } = await sentMessage();
    const bad = `${token.slice(0, -2)}xx`;
    expect((await post(bad)).status).toBe(400);
    expect(await (await get(bad)).text()).toContain('isn’t valid');
    expect(await db.select().from(emailSuppressionList)).toHaveLength(0);
  });

  it('a test token shows the page and writes nothing', async () => {
    const token = signTestToken(SECRET);
    expect((await get(token)).status).toBe(200);
    expect((await post(token)).status).toBe(200);
    expect(await db.select().from(emailSuppressionList)).toHaveLength(0);
  });
});

describe('§7A.8 POST /api/webhooks/resend', () => {
  const hook = new Webhook(WEBHOOK_SECRET);
  let counter = 0;
  function deliver(event: unknown, overrides: { id?: string; signature?: string } = {}) {
    const body = JSON.stringify(event);
    const id = overrides.id ?? `msg_${++counter}`;
    const now = new Date();
    const headers = { 'svix-id': id, 'svix-timestamp': String(Math.floor(now.getTime() / 1000)), 'svix-signature': overrides.signature ?? hook.sign(id, now, body) };
    return webhookRoute.POST(new Request('http://localhost/api/webhooks/resend', { method: 'POST', headers, body }), routeArgs('/api/webhooks/resend') as never);
  }
  async function sent() {
    await configure();
    await send([await addContact({ email: 'asha@example.com' })]);
    return (await messages())[0]!;
  }
  const event = (type: string, email_id: string, data: Record<string, unknown> = {}) => ({ type, created_at: new Date().toISOString(), data: { email_id, ...data } });

  it('moves the status forward and never back', async () => {
    const row = await sent();
    expect((await deliver(event('email.delivered', row.resendId!))).status).toBe(200);
    await deliver(event('email.sent', row.resendId!));
    const [after] = await messages();
    expect(after).toMatchObject({ status: 'delivered' });
    expect(after!.deliveredAt).toBeTruthy();
    expect(after!.sentAt).toBeTruthy();
  });

  it('a hard bounce suppresses the address and opts the contact out, with an audit row', async () => {
    const row = await sent();
    await deliver(event('email.bounced', row.resendId!, { bounce: { type: 'Permanent', subType: 'General', message: 'No such user' } }));
    expect((await messages())[0]).toMatchObject({ status: 'bounced', bounceType: 'Permanent', bounceSubtype: 'General' });
    expect((await db.select().from(emailSuppressionList))[0]).toMatchObject({ email: 'asha@example.com', reason: 'hard_bounce' });
    expect((await db.select().from(schema.contacts))[0]!.emailOptInStatus).toBe('opted_out');
    expect(await db.select().from(auditLog).where(eq(auditLog.userId, 'system:webhook'))).toHaveLength(1);
  });

  it('a transient bounce fails the row but does not suppress', async () => {
    const row = await sent();
    await deliver(event('email.bounced', row.resendId!, { bounce: { type: 'Transient' } }));
    expect((await messages())[0]!.status).toBe('failed');
    expect(await db.select().from(emailSuppressionList)).toHaveLength(0);
  });

  it('a complaint suppresses, and clicks are counted per link', async () => {
    const row = await sent();
    await deliver(event('email.clicked', row.resendId!, { click: { link: 'https://example.com/a' } }));
    await deliver(event('email.clicked', row.resendId!, { click: { link: 'https://example.com/a' } }));
    expect((await db.select().from(emailLinkClicks))[0]).toMatchObject({ url: 'https://example.com/a', clicks: 2 });
    await deliver(event('email.complained', row.resendId!));
    expect((await messages())[0]!.status).toBe('complained');
    expect((await db.select().from(emailSuppressionList))[0]!.reason).toBe('complaint');
  });

  it('matches by the message_id tag when the id was never saved', async () => {
    const row = await sent();
    await db.update(campaignMessages).set({ resendId: null, status: 'unknown' });
    await deliver(event('email.delivered', 'late-id', { tags: { message_id: row.id } }));
    expect((await messages())[0]).toMatchObject({ status: 'delivered', resendId: 'late-id' });
  });

  it('a repeated svix-id is a no-op', async () => {
    const row = await sent();
    await deliver(event('email.clicked', row.resendId!, { click: { link: 'https://example.com/a' } }), { id: 'msg_same' });
    const again = await deliver(event('email.clicked', row.resendId!, { click: { link: 'https://example.com/a' } }), { id: 'msg_same' });
    expect((await again.json()).duplicate).toBe(true);
    expect((await db.select().from(emailLinkClicks))[0]!.clicks).toBe(1);
  });

  it('an invalid signature gets 401, changes nothing, and cannot block the real event', async () => {
    const row = await sent();
    const forged = await deliver(event('email.complained', row.resendId!), { id: 'msg_real', signature: 'v1,bm9wZQ==' });
    expect(forged.status).toBe(401);
    expect((await messages())[0]!.status).toBe('accepted');
    expect((await db.select().from(webhookEvents))[0]).toMatchObject({ signatureOk: false, payloadJson: null });

    expect((await deliver(event('email.delivered', row.resendId!), { id: 'msg_real' })).status).toBe(200);
    expect((await messages())[0]!.status).toBe('delivered');
  });

  it('refuses everything when no secret is configured', async () => {
    const row = await sent();
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    expect((await deliver(event('email.delivered', row.resendId!))).status).toBe(401);
  });

  it('stores an unmatched event and answers 200', async () => {
    expect((await deliver(event('email.delivered', 'nobody'))).status).toBe(200);
    expect((await db.select().from(webhookEvents))[0]!.processedAt).toBeTruthy();
  });
});

describe('Settings', () => {
  const put = (body: unknown) => settingsRoute.PUT(request('/api/settings', 'PUT', { body }), routeArgs('/api/settings'));
  const putKey = (body: unknown) => credentialsRoute.PUT(request('/api/settings/credentials', 'PUT', { body }), routeArgs('/api/settings/credentials'));
  const sources = async () => (await credentialsRoute.GET(request('/api/settings/credentials', 'GET'), routeArgs('/api/settings/credentials'))).json();

  it('saves the signature and address without touching the other email fields', async () => {
    await put({ email: { fromName: 'Grace Ferro' } });
    const res = await put({ email: { signature: 'Regards', postalAddress: '12 Harbour Road' } });
    expect(res.status).toBe(200);
    expect((await res.json()).email).toMatchObject({ fromName: 'Grace Ferro', signature: 'Regards', postalAddress: '12 Harbour Road' });
  });

  it('stores an API key encrypted, never returns it, and audits only its name', async () => {
    expect((await sources()).RESEND_API_KEY).toBe('none');
    const res = await putKey({ RESEND_API_KEY: 're_secretvalue123' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('re_secretvalue123');
    expect((await sources()).RESEND_API_KEY).toBe('settings');
    expect(await getSecret(db, 'RESEND_API_KEY')).toBe('re_secretvalue123');
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'credentials.update'));
    expect(audit!.detailsJson).toEqual({ changed: ['RESEND_API_KEY'] });
  });

  it('refuses something that is not a Resend key, and removes a key with null', async () => {
    expect((await putKey({ RESEND_API_KEY: 'not-a-key' })).status).toBe(400);
    expect((await putKey({})).status).toBe(400);
    await putKey({ RESEND_API_KEY: 're_secretvalue123' });
    await putKey({ RESEND_API_KEY: null });
    expect((await sources()).RESEND_API_KEY).toBe('none');
  });

  it('says when the key came from .local.bin', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_local');
    vi.stubEnv('LOCAL_BIN_KEYS', 'RESEND_API_KEY');
    expect((await sources()).RESEND_API_KEY).toBe('local_bin');
  });
});

describe('§5.9 and §5.10 campaigns, fed by the webhook', () => {
  const hook = new Webhook(WEBHOOK_SECRET);
  let counter = 0;
  function deliver(type: string, email_id: string, data: Record<string, unknown> = {}, signature?: string) {
    const body = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id, ...data } });
    const id = `evt_${++counter}`;
    const now = new Date();
    const headers = { 'svix-id': id, 'svix-timestamp': String(Math.floor(now.getTime() / 1000)), 'svix-signature': signature ?? hook.sign(id, now, body) };
    return webhookRoute.POST(new Request('http://localhost/api/webhooks/resend', { method: 'POST', headers, body }), routeArgs('/api/webhooks/resend') as never);
  }
  const args = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
  const detail = async (id: string) => (await campaignRoute.GET(request(`/api/campaigns/${id}`, 'GET'), args(id))).json();
  const recipients = async (id: string, query = '') => (await campaignMessagesRoute.GET(request(`/api/campaigns/${id}/messages?${query}`, 'GET'), args(id))).json();

  /** Four recipients, with the webhook reporting a different outcome for three. */
  async function scenario() {
    await configure();
    const ids = [];
    for (const email of ['delivered@example.com', 'clicked@example.com', 'bounced@example.com', 'waiting@example.com']) ids.push(await addContact({ email, first_name: 'Asha', last_name: '=Rao' }));
    const { campaign_id } = await (await send(ids)).json();
    const rows = await messages();
    const byAddress = (email: string) => rows.find((m) => m.emailTo === email)!;
    await deliver('email.delivered', byAddress('delivered@example.com').resendId!);
    await deliver('email.delivered', byAddress('clicked@example.com').resendId!);
    await deliver('email.clicked', byAddress('clicked@example.com').resendId!, { click: { link: 'https://example.com/offer' } });
    await deliver('email.bounced', byAddress('bounced@example.com').resendId!, { bounce: { type: 'Permanent', subType: 'General', message: 'No such user' } });
    return campaign_id as string;
  }

  it('the list shows each send with counts that follow webhook events', async () => {
    const id = await scenario();
    const { items, total } = await (await campaignsRoute.GET(request('/api/campaigns', 'GET'), routeArgs('/api/campaigns'))).json();
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ id, channel: 'email', name: SEND.subject, status: 'completed', created_by_email: ME });
    expect(items[0].counts).toMatchObject({ total: 4, accepted: 4, delivered: 2, clicked: 1, opened: 1, bounced: 1 });
    expect(await (await campaignsRoute.GET(request('/api/campaigns?channel=whatsapp', 'GET'), routeArgs('/api/campaigns'))).json()).toMatchObject({ total: 0 });
    expect((await campaignsRoute.GET(request('/api/campaigns?channel=fax', 'GET'), routeArgs('/api/campaigns'))).status).toBe(400);
  });

  it('a clicked row counts as delivered and opened, and the bar parts add up', async () => {
    const { counts, top_links, from, message, webhook_connected, thresholds } = await detail(await scenario());
    expect(counts).toMatchObject({ seg_delivered: 2, seg_waiting: 1, seg_problem: 1, seg_skipped: 0 });
    expect(counts.seg_delivered + counts.seg_waiting + counts.seg_problem + counts.seg_skipped).toBe(counts.total);
    expect(top_links).toEqual([{ url: 'https://example.com/offer', clicks: 1 }]);
    expect(from).toBe('"Grace Ferro" <offers@mail.example.com>');
    expect(message).toBe(SEND.body);
    expect(webhook_connected).toBe(true);
    expect(thresholds).toEqual({ bounce: 5, complaint: 0.3 });
  });

  it('ES-12 a hard bounce after an open still counts as a bounce, though the status stays opened', async () => {
    const id = await scenario();
    const [row] = (await messages()).filter((m) => m.emailTo === 'delivered@example.com');
    await deliver('email.opened', row!.resendId!);
    await deliver('email.bounced', row!.resendId!, { bounce: { type: 'Permanent' } });
    expect((await detail(id)).counts).toMatchObject({ bounced: 2, seg_delivered: 2 });
  });

  it('filters recipients, and pages them', async () => {
    const id = await scenario();
    const problems = await recipients(id, 'filter=problems');
    expect(problems.total).toBe(1);
    expect(problems.items[0]).toMatchObject({ email_to: 'bounced@example.com', status: 'bounced', bounce_type: 'Permanent', first_name: 'Asha' });
    expect((await recipients(id, 'filter=waiting')).items.map((m: { email_to: string }) => m.email_to)).toEqual(['waiting@example.com']);
    expect((await recipients(id, 'filter=delivered')).total).toBe(2);
    const paged = await recipients(id, 'page=2&page_size=3');
    expect(paged).toMatchObject({ total: 4 });
    expect(paged.items).toHaveLength(1);
    expect((await campaignMessagesRoute.GET(request(`/api/campaigns/${id}/messages?filter=nope`, 'GET'), args(id))).status).toBe(400);
  });

  it('exports failures as CSV, and audits the export', async () => {
    const id = await scenario();
    const res = await campaignFailuresRoute.GET(request(`/api/campaigns/${id}/failures`, 'GET'), args(id));
    expect(res.headers.get('content-type')).toContain('text/csv');
    const [header, row, ...rest] = (await res.text()).trim().split('\r\n');
    expect(header).toContain('Address,Name,Status');
    expect(rest).toHaveLength(0);
    expect(row).toBe('bounced@example.com,Asha =Rao,bounced,Permanent,General,,No such user,1');
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'campaign.export_failures'))).toHaveLength(1);
  });

  it('an unknown campaign is a 404 on every route', async () => {
    expect((await campaignRoute.GET(request('/api/campaigns/nope', 'GET'), args('nope'))).status).toBe(404);
    expect((await campaignMessagesRoute.GET(request('/api/campaigns/nope/messages', 'GET'), args('nope'))).status).toBe(404);
    expect((await campaignFailuresRoute.GET(request('/api/campaigns/nope/failures', 'GET'), args('nope'))).status).toBe(404);
  });

  it('shows a send that died as interrupted', async () => {
    const [held] = await db.insert(campaigns).values({ channel: 'email', name: 'Dead', status: 'running', heartbeatAt: new Date(Date.now() - 20 * 60 * 1000) }).returning();
    expect((await detail(held!.id)).status).toBe('interrupted');
  });

  describe('GET /api/settings/email-webhook', () => {
    const status = async () => (await webhookStatusRoute.GET(request('/api/settings/email-webhook', 'GET'), routeArgs('/api/settings/email-webhook'))).json();

    it('gives the link and events, and warns that localhost is unreachable', async () => {
      const data = await status();
      expect(data).toMatchObject({ url: 'http://localhost/api/webhooks/resend', notice: 'localhost', secret_set: true, last_event_at: null, rejected_at: null });
      expect(data.events).toEqual(expect.arrayContaining(['email.delivered', 'email.bounced', 'email.complained', 'email.suppressed']));
    });

    it('uses APP_URL, the address Resend can actually reach', async () => {
      vi.stubEnv('APP_URL', 'https://wa.example.com');
      expect(await status()).toMatchObject({ url: 'https://wa.example.com/api/webhooks/resend', notice: null });
    });

    it('reports the last event, and a refusal only if nothing has got through since', async () => {
      expect((await deliver('email.delivered', 'x', {}, 'v1,bm9wZQ==')).status).toBe(401);
      expect((await status()).rejected_at).toBeTruthy();
      await deliver('email.delivered', 'x');
      const data = await status();
      expect(data.last_event_type).toBe('email.delivered');
      expect(data.last_event_at).toBeTruthy();
      expect(data.rejected_at).toBeNull();
    });
  });
});
