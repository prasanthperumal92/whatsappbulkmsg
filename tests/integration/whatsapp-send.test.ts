import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as contactsRoute from '@/app/api/contacts/route';
import * as campaignRoute from '@/app/api/campaigns/[id]/route';
import * as credentialsRoute from '@/app/api/settings/credentials/route';
import * as webhookStatusRoute from '@/app/api/settings/whatsapp-webhook/route';
import * as webhookRoute from '@/app/api/webhooks/whatsapp/route';
import * as connectionRoute from '@/app/api/whatsapp/connection/route';
import * as previewRoute from '@/app/api/whatsapp/preview/route';
import * as sendRoute from '@/app/api/whatsapp/send/route';
import * as syncRoute from '@/app/api/whatsapp/templates/sync/route';
import * as templatesRoute from '@/app/api/whatsapp/templates/route';
import * as testRoute from '@/app/api/whatsapp/test/route';
import { getDb, schema } from '@/lib/db';
import { getSecret } from '@/lib/settings/secrets';
import { getSettings, updateSettings } from '@/lib/settings/store';
import { addSuppression } from '@/lib/suppression/service';
import { resetClerk, signInAs } from '../support/clerk-mock';
import { resetDb } from '../support/reset';
import { request, routeArgs } from '../support/routes';

const db = getDb();
const { auditLog, campaignMessages, campaigns, contacts, contactActivity, suppressionList, teamAllowlist, templates, webhookEvents, whatsappIdentities } = schema;
const ME = 'asha.member@example.com';
const TOKEN = 'EAAG-test-token-do-not-leak-1234567890';
const APP_SECRET = 'app-secret-for-tests-1234';
const META_TEMPLATES = [
  { id: '111', name: 'festive', status: 'APPROVED', category: 'MARKETING', language: 'en', parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Hi {{first_name}}, {{discount}} off this week.' }] },
  { id: '222', name: 'waiting', status: 'PENDING', category: 'MARKETING', language: 'en', components: [{ type: 'BODY', text: 'Soon' }] },
];
const MAPPING = { first_name: { field: 'first_name', fallback: 'there' }, discount: { static: '15%' } };

type GraphCall = { url: string; auth: string | null; body: unknown };
let calls: GraphCall[];
let answerSend: (body: { to: string }) => Response;

const call = (mod: { POST: (req: Request, args: never) => Promise<Response> }, path: string, body?: unknown) => mod.POST(request(path, 'POST', { body }), routeArgs(path) as never);
const addContact = async (fields: Record<string, unknown>) => {
  const res = await call(contactsRoute, '/api/contacts', { whatsapp_consent_confirmed: true, ...fields });
  expect(res.status).toBe(201);
  return (await res.json()).contact_id as string;
};
const connect = async () => {
  const res = await credentialsRoute.PUT(request('/api/settings/credentials', 'PUT', { body: { WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_WABA_ID: '100', WHATSAPP_PHONE_NUMBER_ID: '200', META_APP_SECRET: APP_SECRET } }), routeArgs('/api/settings/credentials'));
  expect(res.status).toBe(200);
};
const syncedId = async () => {
  expect((await call(syncRoute, '/api/whatsapp/templates/sync')).status).toBe(200);
  const [row] = await db.select().from(templates).where(eq(templates.name, 'festive'));
  return row!.id;
};
const send = (template_id: string, ids: string[], extra: Record<string, unknown> = {}) => call(sendRoute, '/api/whatsapp/send', { selection: { mode: 'ids', ids }, template_id, mapping: MAPPING, expected_recipients: ids.length, ...extra });
const postWebhook = (payload: unknown, secret = APP_SECRET) => {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return webhookRoute.POST(new Request('http://localhost/api/webhooks/whatsapp', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': signature } }), routeArgs('/api/webhooks/whatsapp') as never);
};
const statusEvent = (status: Record<string, unknown>) => ({ entry: [{ changes: [{ field: 'messages', value: { statuses: [status] } }] }] });
const inbound = (message: Record<string, unknown>) => ({ entry: [{ changes: [{ field: 'messages', value: { messages: [message] } }] }] });
const messages = () => db.select().from(campaignMessages);

beforeEach(async () => {
  await resetDb();
  resetClerk();
  calls = [];
  answerSend = (body) => Response.json({ contacts: [{ wa_id: body.to }], messages: [{ id: `wamid.${body.to}`, message_status: 'accepted' }] });
  // Production: the one environment where Mock is impossible, so these go through the real Graph client.
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('APP_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  for (const name of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_WABA_ID', 'WHATSAPP_PHONE_NUMBER_ID', 'META_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN']) vi.stubEnv(name, '');
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    if (url.includes('/message_templates')) return Response.json({ data: META_TEMPLATES });
    if (url.endsWith('/messages')) return answerSend(body);
    return Response.json({ display_phone_number: '+91 90000 00000', verified_name: 'Grace Ferro', quality_rating: 'GREEN', whatsapp_business_manager_messaging_limit: 'TIER_2K' });
  });
  await db.insert(teamAllowlist).values({ email: ME });
  signInAs(ME, 'user_asha');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('credentials from Settings', () => {
  it('saves the token encrypted, never returns it, and connects with it', async () => {
    await connect();
    const described = await (await credentialsRoute.GET(request('/api/settings/credentials', 'GET'), routeArgs('/api/settings/credentials'))).text();
    expect(described).not.toContain(TOKEN);
    expect(JSON.parse(described).WHATSAPP_ACCESS_TOKEN).toBe('settings');
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'secrets'));
    expect(JSON.stringify(row!.valueJson)).not.toContain(TOKEN);
    expect(await getSecret(db, 'WHATSAPP_ACCESS_TOKEN')).toBe(TOKEN);

    const res = await call(connectionRoute, '/api/whatsapp/connection');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified_name: 'Grace Ferro', messaging_limit: 'TIER_2K', provider: 'graph' });
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN))).toBe(true);
    expect(calls[0]!.url).toContain('https://graph.facebook.com/v26.0/200?fields=');
    expect((await getSettings(db)).whatsappSending.messagingLimitTier).toBe('TIER_2K');
    const audits = await db.select().from(auditLog);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it('refuses a malformed value', async () => {
    const res = await credentialsRoute.PUT(request('/api/settings/credentials', 'PUT', { body: { WHATSAPP_WABA_ID: 'not digits' } }), routeArgs('/api/settings/credentials'));
    expect(res.status).toBe(400);
  });

  it('isn’t connected in production without credentials, and shows no Mock', async () => {
    const res = await call(connectionRoute, '/api/whatsapp/connection');
    expect(res.status).toBe(409);
  });

  it('explains a refused token without leaking it', async () => {
    await connect();
    vi.stubGlobal('fetch', async () => Response.json({ error: { code: 190, message: 'Error validating access token' } }, { status: 401 }));
    const res = await call(connectionRoute, '/api/whatsapp/connection');
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('Error validating access token');
    expect(text).not.toContain(TOKEN);
  });
});

describe('templates', () => {
  it('syncs from Meta, updates in place and drops what Meta no longer lists', async () => {
    await connect();
    const id = await syncedId();
    const list = await (await templatesRoute.GET(request('/api/whatsapp/templates', 'GET'), routeArgs('/api/whatsapp/templates'))).json();
    expect(list.items.map((t: { name: string; status: string }) => [t.name, t.status])).toEqual([['festive', 'APPROVED'], ['waiting', 'PENDING']]);
    META_TEMPLATES[1]!.status = 'APPROVED';
    const second = await (await call(syncRoute, '/api/whatsapp/templates/sync')).json();
    META_TEMPLATES[1]!.status = 'PENDING';
    expect(second).toEqual({ synced: 2, removed: 0 });
    expect(await syncedId()).toBe(id);

    vi.stubGlobal('fetch', async () => Response.json({ data: [META_TEMPLATES[0]] }));
    expect(await (await call(syncRoute, '/api/whatsapp/templates/sync')).json()).toEqual({ synced: 1, removed: 1 });
  });

  it('applies a review result from the webhook', async () => {
    await connect();
    await syncedId();
    await postWebhook({ entry: [{ changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: 222, reason: 'ABUSIVE_CONTENT' } }] }] });
    const [row] = await db.select().from(templates).where(eq(templates.metaTemplateId, '222'));
    expect(row).toMatchObject({ status: 'REJECTED', rejectedReason: 'ABUSIVE_CONTENT' });
  });
});

describe('sending', () => {
  it('sends the frozen template to each recipient and records it', async () => {
    await connect();
    const id = await syncedId();
    const asha = await addContact({ phone: '+919876543210', first_name: 'Asha' });
    const noName = await addContact({ phone: '+919876543211' });
    calls = [];

    const res = await send(id, [asha, noName]);
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary).toMatchObject({ accepted: 2, failed: 0, skipped: 0, unknown: 0, stopped_reason: null });

    expect(calls).toHaveLength(2);
    const toAsha = calls.find((c) => (c.body as { to: string }).to === '919876543210')!;
    expect(toAsha.url).toBe('https://graph.facebook.com/v26.0/200/messages');
    expect(toAsha.auth).toBe(`Bearer ${TOKEN}`);
    const rows = await messages();
    const ashaRow = rows.find((r) => r.contactId === asha)!;
    expect(toAsha.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      biz_opaque_callback_data: ashaRow.id,
      template: { name: 'festive', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Asha' }, { type: 'text', parameter_name: 'discount', text: '15%' }] }] },
    });
    expect(JSON.stringify(calls.find((c) => (c.body as { to: string }).to === '919876543211')!.body)).toContain('there');
    expect(ashaRow).toMatchObject({ status: 'accepted', wamid: 'wamid.919876543210', channel: 'whatsapp', phoneE164: '+919876543210' });
    const [activity] = await db.select().from(contactActivity).where(eq(contactActivity.contactId, asha));
    expect(activity).toMatchObject({ totalSent: 1, lastCampaignId: summary.campaign_id });
    const [campaign] = await db.select().from(campaigns);
    expect(campaign).toMatchObject({ channel: 'whatsapp', status: 'completed', name: 'festive' });
    const detail = await (await campaignRoute.GET(request(`/api/campaigns/${summary.campaign_id}`, 'GET'), { params: Promise.resolve({ id: summary.campaign_id }) } as never)).json();
    expect(detail).toMatchObject({ channel: 'whatsapp', webhook_connected: true, message: 'Hi {{first_name}}, {{discount}} off this week.', created_by_email: ME });
    expect(detail.counts).toMatchObject({ total: 2, accepted: 2 });
  });

  it('leaves out who it must, and refuses a stale count', async () => {
    await connect();
    const id = await syncedId();
    const ok = await addContact({ phone: '+919876543210', first_name: 'Asha' });
    const suppressed = await addContact({ phone: '+919876543211' });
    const unknown = await addContact({ phone: '+919876543212', whatsapp_consent_confirmed: false });
    const us = await addContact({ phone: '+12025550123' });
    const emailOnly = await addContact({ email: 'only@example.com', whatsapp_consent_confirmed: false });
    await addSuppression(db, { channel: 'whatsapp', identifier: '+919876543211', reason: 'manual' });
    const ids = [ok, suppressed, unknown, us, emailOnly];

    const preview = await (await call(previewRoute, '/api/whatsapp/preview', { selection: { mode: 'ids', ids }, template_id: id, mapping: MAPPING })).json();
    expect(preview).toMatchObject({ selected: 5, recipients: 1, provider: 'graph', problems: [], sample: 'Hi Asha, 15% off this week.' });
    expect(preview.excluded).toMatchObject({ suppressed: 1, opted_out: 0, unknown_consent: 1, restricted_country: 1, no_phone: 1 });

    expect((await send(id, ids)).status).toBe(409);
    calls = [];
    expect((await send(id, ids, { expected_recipients: 1 })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('won’t send an empty variable, an unapproved template or past the messaging limit', async () => {
    await connect();
    const id = await syncedId();
    const asha = await addContact({ phone: '+919876543210', first_name: 'Asha' });
    const preview = await (await call(previewRoute, '/api/whatsapp/preview', { selection: { mode: 'ids', ids: [asha] }, template_id: id, mapping: { first_name: { field: 'company' }, discount: { static: '' } } })).json();
    expect(preview.recipients).toBe(0);
    expect(preview.excluded.empty_variable).toBe(1);

    const [pending] = await db.select().from(templates).where(eq(templates.name, 'waiting'));
    expect((await send(pending!.id, [asha])).status).toBe(409);

    await updateSettings(db, { whatsappSending: { messagingLimitTier: 'TIER_250' } });
    await db.insert(campaigns).values({ id: 'old', channel: 'whatsapp', name: 'old', status: 'completed' });
    await db.insert(campaignMessages).values(Array.from({ length: 250 }, (_, i) => ({ campaignId: 'old', contactId: crypto.randomUUID(), channel: 'whatsapp', phoneE164: `+9190000${i}`, status: 'accepted', acceptedAt: new Date() })));
    const res = await send(id, [asha]);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('250');
  });

  it('suppresses on 131050, and carries on', async () => {
    await connect();
    const id = await syncedId();
    const stopped = await addContact({ phone: '+919876543210' });
    const fine = await addContact({ phone: '+919876543211' });
    answerSend = (body) => (body.to === '919876543210' ? Response.json({ error: { code: 131050, message: 'User stopped marketing messages', fbtrace_id: 'trace1' } }, { status: 400 }) : Response.json({ messages: [{ id: 'wamid.ok' }] }));
    const summary = await (await send(id, [stopped, fine])).json();
    expect(summary).toMatchObject({ accepted: 1, failed: 1, stopped_reason: null });
    const rows = await messages();
    expect(rows.find((r) => r.contactId === stopped)).toMatchObject({ status: 'failed', errorCode: '131050', fbtraceId: 'trace1' });
    expect(await db.select().from(suppressionList)).toMatchObject([{ phoneE164: '+919876543210', reason: 'error_131050' }]);
    const [contact] = await db.select().from(contacts).where(eq(contacts.contactId, stopped));
    expect(contact!.optInStatus).toBe('opted_out');
  });

  it('stops the whole send on a bad token, and says why', async () => {
    await connect();
    const id = await syncedId();
    const ids = [await addContact({ phone: '+919876543210' }), await addContact({ phone: '+919876543211' })];
    await updateSettings(db, { whatsappSending: { messagesPerSecond: 1 } });
    answerSend = () => Response.json({ error: { code: 190, message: 'Token expired' } }, { status: 401 });
    const summary = await (await send(id, ids)).json();
    expect(summary.stopped_reason).toContain('Update it in Settings');
    expect(summary).toMatchObject({ accepted: 0, failed: 1, skipped: 1 });
    expect((await db.select().from(campaigns))[0]).toMatchObject({ status: 'failed' });
    expect((await messages()).map((m) => m.status).sort()).toEqual(['failed', 'skipped']);
  });

  it('marks a timeout unknown rather than failed, and doesn’t retry it', async () => {
    await connect();
    const id = await syncedId();
    const ids = [await addContact({ phone: '+919876543210' })];
    let sends = 0;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/messages')) {
        sends++;
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return original(input, init);
    });
    const summary = await (await send(id, ids)).json();
    expect(sends).toBe(1);
    expect(summary).toMatchObject({ accepted: 0, unknown: 1 });
    expect(summary.stopped_reason).toContain('may have gone out');
  });

  it('won’t run two sends at once', async () => {
    await connect();
    const id = await syncedId();
    const asha = await addContact({ phone: '+919876543210' });
    await db.insert(campaigns).values({ id: 'running', channel: 'whatsapp', name: 'x', status: 'running', heartbeatAt: new Date() });
    const res = await send(id, [asha]);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('send_in_progress');
  });

  it('sends a test with sample values, recording nothing against a contact', async () => {
    await connect();
    const id = await syncedId();
    calls = [];
    const res = await call(testRoute, '/api/whatsapp/test', { template_id: id, mapping: MAPPING, to: '+91 98765 43210' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ to: '+919876543210', provider: 'graph' });
    expect(JSON.stringify(calls[0]!.body)).toContain('Asha');
    expect(await messages()).toEqual([]);
    expect((await call(testRoute, '/api/whatsapp/test', { template_id: id, mapping: MAPPING, to: 'nope' })).status).toBe(400);
  });
});

describe('webhook', () => {
  const sent = async () => {
    await connect();
    const id = await syncedId();
    const asha = await addContact({ phone: '+919876543210', first_name: 'Asha' });
    await send(id, [asha]);
    return (await messages())[0]!;
  };

  it('answers Meta’s handshake only with the right token', async () => {
    const status = await (await webhookStatusRoute.GET(request('/api/settings/whatsapp-webhook', 'GET'), routeArgs('/api/settings/whatsapp-webhook'))).json();
    expect(status.url).toContain('/api/webhooks/whatsapp');
    const handshake = (token: string) => webhookRoute.GET(new Request(`http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=abc123`), routeArgs('/api/webhooks/whatsapp') as never);
    const ok = await handshake(status.verify_token);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('abc123');
    expect((await handshake('wrong')).status).toBe(403);
  });

  it('refuses a bad signature and processes nothing', async () => {
    const row = await sent();
    const res = await postWebhook(statusEvent({ id: row.wamid, status: 'delivered', timestamp: '1790000000' }), 'wrong-secret');
    expect(res.status).toBe(401);
    expect((await messages())[0]!.status).toBe('accepted');
    const [event] = await db.select().from(webhookEvents).where(eq(webhookEvents.signatureOk, false));
    expect(event!.payloadJson).toBeNull();
  });

  it('moves a status forward only, matches on either id, and ignores a repeat', async () => {
    const row = await sent();
    await postWebhook(statusEvent({ id: row.wamid, status: 'read', timestamp: '1790000100', biz_opaque_callback_data: row.id, pricing: { category: 'marketing' } }));
    let [now] = await messages();
    expect(now).toMatchObject({ status: 'read', priceCategory: 'marketing' });
    expect(now!.readAt?.getTime()).toBe(1790000100000);

    await postWebhook(statusEvent({ id: row.wamid, status: 'delivered', timestamp: '1790000000' }));
    [now] = await messages();
    expect(now!.status).toBe('read');
    expect(now!.deliveredAt?.getTime()).toBe(1790000000000);

    const same = statusEvent({ id: row.wamid, status: 'sent', timestamp: '1789999999' });
    await postWebhook(same);
    expect(await (await postWebhook(same)).json()).toEqual({ ok: true, duplicate: true });
    const detail = await (await campaignRoute.GET(request(`/api/campaigns/${row.campaignId}`, 'GET'), { params: Promise.resolve({ id: row.campaignId }) } as never)).json();
    expect(detail.counts).toMatchObject({ delivered: 1, read: 1, seg_delivered: 1, seg_waiting: 0 });
  });

  it('records a failed status, and suppresses on 131050 once', async () => {
    const row = await sent();
    const failed = { id: row.wamid, status: 'failed', timestamp: '1790000000', errors: [{ code: 131050, title: 'Stopped', error_data: { details: 'User stopped marketing' } }] };
    await postWebhook(statusEvent(failed));
    expect((await messages())[0]).toMatchObject({ status: 'failed', errorCode: '131050', errorTitle: 'Stopped', errorDetail: 'User stopped marketing' });
    expect(await db.select().from(suppressionList)).toHaveLength(1);
    await postWebhook(statusEvent({ ...failed, timestamp: '1790000001' }));
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'whatsapp.suppressed')))).toHaveLength(1);
  });

  it('opts someone out when they reply STOP, and only then', async () => {
    await sent();
    await postWebhook(inbound({ type: 'text', from: '919876543210', text: { body: 'stop please, thanks' } }));
    expect(await db.select().from(suppressionList)).toEqual([]);
    await postWebhook(inbound({ type: 'text', from: '919876543210', text: { body: ' Stop! ' } }));
    expect(await db.select().from(suppressionList)).toMatchObject([{ phoneE164: '+919876543210', reason: 'stop_keyword', createdBy: 'system:webhook' }]);
    const [contact] = await db.select().from(contacts);
    expect(contact!.optInStatus).toBe('opted_out');
  });

  it('opts someone out from the button', async () => {
    await connect();
    await postWebhook(inbound({ type: 'button', from: '919876543210', button: { text: 'Stop promotions', payload: 'x' } }));
    expect(await db.select().from(suppressionList)).toMatchObject([{ reason: 'button' }]);
  });

  it('holds a STOP with no phone until the phone is known', async () => {
    await connect();
    await postWebhook(inbound({ type: 'text', from_user_id: 'IN.bsuid1', text: { body: 'STOP' } }));
    expect(await db.select().from(suppressionList)).toEqual([]);
    expect((await db.select().from(whatsappIdentities))[0]!.suppressedAt).toBeTruthy();
    await postWebhook({ entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: '919876543210', user_id: 'IN.bsuid1' }] } }] }] });
    expect(await db.select().from(suppressionList)).toMatchObject([{ phoneE164: '+919876543210' }]);
  });

  it('answers 200 to a payload it can’t use', async () => {
    await connect();
    expect((await postWebhook({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'unknown-id', status: 'delivered' }, { status: 'something_new' }] } }] }] })).status).toBe(200);
  });
});
