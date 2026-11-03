import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import signatureGolden from '../../evals/golden/email-webhook-signature.json';
import statusGolden from '../../evals/golden/email-status-transitions.json';
import csvGolden from '../../evals/golden/csv-export-escaping.json';
import { protectCell, toCsv } from '@/lib/csv-export';
import { capWindows, planAudience, type AudienceInput } from '@/lib/email/audience';
import { COMPOSE_MAPPING, fromHeader, toTemplate } from '@/lib/email/compose';
import { classifyEmailError } from '@/lib/email/errors';
import { buildEmailElement } from '@/lib/email/payload';
import { createMockProvider, createResendProvider, EmailProviderError } from '@/lib/email/provider';
import { reduceEmailStatus, type EmailStatus } from '@/lib/email/status';
import { verifyResendSignature } from '@/lib/email/webhook';
import { appUrl } from '@/lib/env';
import { loadLocalBin } from '@/lib/local-bin';
import { settingsSchema } from '@/lib/settings/schema';
import type { ContactRow } from '@/lib/contacts/store';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ES-* email status reducer', () => {
  type Case = { id: string; note?: string; current: string; incoming: string; bounce_type?: string; expect: string; suppress: boolean; reason?: string };
  it.each(statusGolden.cases as Case[])('$id $current + $incoming', (c) => {
    const result = reduceEmailStatus(c.current as EmailStatus, { type: c.incoming, bounce_type: c.bounce_type });
    expect(result.status).toBe(c.expect);
    expect(Boolean(result.suppress)).toBe(c.suppress);
    if (c.reason) expect(result.suppress).toBe(c.reason);
  });
});

describe('RS-* webhook signature', () => {
  type Case = { id: string; note: string; svix_id: string | null; svix_timestamp: string | null; svix_signature: string | null; body: string; now: number; valid: boolean; webhook_secret?: string };
  it.each(signatureGolden.cases as unknown as Case[])('$id $note', (c) => {
    vi.useFakeTimers();
    vi.setSystemTime(c.now * 1000);
    const headers = { id: c.svix_id ?? null, timestamp: c.svix_timestamp ?? null, signature: c.svix_signature ?? null };
    expect(verifyResendSignature(c.body, headers, c.webhook_secret ?? signatureGolden.webhook_secret)).toBe(c.valid);
  });
});

describe('§7A.7 error table', () => {
  it.each([
    [401, 'invalid_api_key', 'bad', 'stop'],
    [403, 'validation_error', 'The example.com domain is not verified', 'stop'],
    [403, null, 'nope', 'stop'],
    [422, 'invalid_from_address', 'bad from', 'stop'],
    [422, 'validation_error', 'Invalid `from` field', 'stop'],
    [422, 'validation_error', 'Invalid `to` field', 'split'],
    [400, 'invalid_parameter', 'bad', 'split'],
    [429, 'rate_limit_exceeded', 'slow down', 'retry'],
    [429, 'daily_quota_exceeded', 'quota', 'stop'],
    [429, 'monthly_quota_exceeded', 'quota', 'stop'],
    [500, 'internal_server_error', 'oops', 'retry'],
    [null, 'application_error', 'no network', 'retry'],
    [409, 'concurrent_idempotent_requests', 'busy', 'retry'],
    [409, 'invalid_idempotent_request', 'mismatch', 'stop'],
    [418, 'something_new', 'huh', 'stop'],
  ] as const)('%s %s (%s) → %s', (status, code, message, action) => {
    expect(classifyEmailError({ status, code, message })).toBe(action);
  });
});

const contact = (n: number, patch: Partial<ContactRow> = {}): ContactRow =>
  ({ contact_id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`, email: `c${n}@example.com`, email_opt_in_status: 'opted_in', country_iso: 'IN', is_deleted: false, ...patch }) as ContactRow;

const NOW = new Date('2026-11-03T06:00:00Z');
const plan = (contacts: ContactRow[], over: Partial<AudienceInput> = {}) =>
  planAudience({ contacts, suppressed: new Set(), lastEmailed: new Map(), frequencyCapDays: 7, unknownConsentLimit: 500, strictConsentCountries: ['DE'], includeUnknown: false, now: NOW, ...over });

describe('§5.8 email audience', () => {
  it('keeps opted-in contacts and counts each exclusion', () => {
    const result = plan(
      [contact(1), contact(2, { email: null }), contact(3, { email_opt_in_status: 'opted_out' }), contact(4, { email_opt_in_status: 'unknown' }), contact(5, { is_deleted: true }), contact(6), contact(7), contact(8, { email: 'c7@example.com' })],
      { suppressed: new Set(['c6@example.com']) },
    );
    expect(result.recipients.map((c) => c.email)).toEqual(['c1@example.com', 'c7@example.com']);
    expect(result).toMatchObject({ selected: 8, excluded: { no_email: 1, opted_out: 1, unknown_consent: 1, deleted: 1, suppressed: 1, duplicate_address: 1, frequency_cap: 0 } });
  });

  it('D15 includes unknown only when asked, never in a strict country or with no country, and up to the limit', () => {
    const unknown = (n: number, country_iso: string | null = 'IN') => contact(n, { email_opt_in_status: 'unknown', country_iso });
    const contacts = [unknown(1), unknown(2, 'DE'), unknown(3, null), unknown(4), unknown(5)];
    expect(plan(contacts).recipients).toHaveLength(0);
    const result = plan(contacts, { includeUnknown: true, unknownConsentLimit: 2 });
    expect(result.recipients.map((c) => c.email)).toEqual(['c1@example.com', 'c4@example.com']);
    expect(result.excluded.unknown_consent).toBe(3);
  });

  it('a duplicate address goes to whichever contact has consent, not the first that was left out', () => {
    const result = plan([contact(1, { email: 'same@example.com', email_opt_in_status: 'unknown' }), contact(2, { email: 'same@example.com' })]);
    expect(result.recipients.map((c) => c.contact_id)).toEqual([contact(2).contact_id]);
    expect(result.excluded).toMatchObject({ unknown_consent: 1, duplicate_address: 0 });
  });

  it('applies the frequency cap, and 0 turns it off', () => {
    const lastEmailed = new Map([[contact(1).contact_id, new Date(NOW.getTime() - 86_400_000)], [contact(2).contact_id, new Date(NOW.getTime() - 8 * 86_400_000)]]);
    expect(plan([contact(1), contact(2)], { lastEmailed }).recipients.map((c) => c.email)).toEqual(['c2@example.com']);
    expect(plan([contact(1), contact(2)], { lastEmailed, frequencyCapDays: 0 }).recipients).toHaveLength(2);
  });

  it('counts role addresses as a warning, not an exclusion', () => {
    const result = plan([contact(1, { email: 'info@example.com' })]);
    expect(result).toMatchObject({ role_addresses: 1 });
    expect(result.recipients).toHaveLength(1);
  });

  it('§7A.6 quota windows follow the IST day and month', () => {
    const { day, month } = capWindows(new Date('2026-11-30T19:00:00Z')); // 00:30 on 1 December, IST.
    expect(day.toISOString()).toBe('2026-11-30T18:30:00.000Z');
    expect(month.toISOString()).toBe('2026-11-30T18:30:00.000Z');
  });
});

describe('composed emails', () => {
  const settings = { from: '"Grace Ferro" <offers@mail.example.com>', postal_address: '12 Harbour Road\nKochi 682001\n\nIndia', app_url: 'https://wa.example.com', signature: 'Regards,\nAsha\n[Website](https://example.com)' };
  const build = (body: string, contactPatch: Record<string, unknown> = {}) =>
    buildEmailElement({ template: toTemplate({ subject: 'Hi {{first_name}}', body }), mapping: COMPOSE_MAPPING, contact: { email: 'c@example.com', ...contactPatch }, settings, secret: 's', message_id: '0192f4e0-0000-7000-8000-000000000042' });

  it('splits paragraphs into blocks, keeps line breaks, and uses "there" for a missing first name', async () => {
    const result = await build('Line one\nLine two\n\nSecond paragraph');
    if (!('element' in result)) throw new Error('skipped');
    expect(result.element.subject).toBe('Hi there');
    expect(result.element.html).toMatch(/Line one(<!-- -->)?<br\/?>(<!-- -->)?Line two/);
    expect(result.element.text).toContain('Line one\nLine two\n\nSecond paragraph');
  });

  it('adds the signature above the footer, and the address on one line', async () => {
    const result = await build('Hello');
    if (!('element' in result)) throw new Error('skipped');
    const { html, text } = result.element;
    expect(html).toContain('href="https://example.com"');
    expect(html.indexOf('Regards')).toBeLessThan(html.indexOf('12 Harbour Road'));
    expect(html).toContain('Grace Ferro, 12 Harbour Road, Kochi 682001, India');
    expect(text).toContain('Regards,\nAsha\nWebsite (https://example.com)\n\n—\nGrace Ferro, 12 Harbour Road, Kochi 682001, India');
    expect(result.element.headers['List-Unsubscribe']).toContain('https://wa.example.com/u/');
  });

  it('a signature cannot pull in contact values, and HTML in it is escaped', async () => {
    const result = await buildEmailElement({ template: toTemplate({ subject: 'S', body: 'B' }), mapping: COMPOSE_MAPPING, contact: { email: 'c@example.com', first_name: 'Asha' }, settings: { ...settings, signature: '{{first_name}} <b>x</b>' }, secret: 's', message_id: 'm' });
    if (!('element' in result)) throw new Error('skipped');
    expect(result.element.html).toContain('{{first_name}}');
    expect(result.element.html).not.toContain('<b>x</b>');
  });

  it('skips a contact missing a variable with no fallback', async () => {
    expect(await build('Hello {{company}}')).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
  });

  it('refuses a variable that does not exist', () => {
    expect(() => toTemplate({ subject: 'S', body: 'Hi {{nickname}}' })).toThrow(/nickname/);
  });

  it('quotes the from name and strips anything that could break the header', () => {
    expect(fromHeader('Grace, "Ferro"\r\nBcc: x', 'a@b.com')).toBe('"Grace, FerroBcc: x" <a@b.com>');
  });

  it('settings accept a signature and refuse an oversized one', () => {
    expect(settingsSchema.email.parse({}).signature).toBeNull();
    expect(settingsSchema.email.safeParse({ signature: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('§7A.3 Resend provider, through the real SDK', () => {
  const email = { from: 'a@b.com', to: ['c@d.com'] as [string], reply_to: 'r@b.com', subject: 'S', html: '<p>H</p>', text: 'T', headers: { 'List-Unsubscribe': '<https://x/u/t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' as const } };
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('posts the batch with the idempotency key and returns ids in order', async () => {
    const fetchMock = respond(200, { data: [{ id: 'one' }, { id: 'two' }] });
    expect(await createResendProvider('re_test').sendBatch([email, email], 'key-1')).toEqual(['one', 'two']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails/batch');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer re_test');
    expect(headers.get('idempotency-key')).toBe('key-1');
    const [sent] = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ to: ['c@d.com'], reply_to: 'r@b.com', headers: email.headers });
  });

  it('sends one email', async () => {
    respond(200, { id: 'solo' });
    expect(await createResendProvider('re_test').sendOne(email, 'msg_1')).toBe('solo');
  });

  it('turns an API error into a typed error with Retry-After', async () => {
    respond(429, { name: 'rate_limit_exceeded', message: 'Too many', statusCode: 429 }, { 'retry-after': '7' });
    const err = await createResendProvider('re_test').sendBatch([email], 'k').catch((e) => e);
    expect(err).toBeInstanceOf(EmailProviderError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limit_exceeded', retryAfter: 7 });
  });

  it('turns a network failure into a retryable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    const err = await createResendProvider('re_test').sendBatch([email], 'k').catch((e) => e);
    expect(err).toMatchObject({ status: null, code: 'application_error' });
    expect(classifyEmailError(err)).toBe('retry');
  });

  it('Mock returns the same ids for the same key', async () => {
    const mock = createMockProvider();
    const first = await mock.sendBatch([email], 'k');
    expect(await mock.sendBatch([email], 'k')).toEqual(first);
    expect(await mock.sendBatch([email], 'other')).not.toEqual(first);
  });
});

describe('§7A.1 .local.bin', () => {
  const write = (text: string) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'local-bin-')), '.local.bin');
    writeFileSync(file, text);
    return file;
  };

  it('beats values already set, and records names only', () => {
    const env: Record<string, string | undefined> = { RESEND_API_KEY: 'from-env-file', NODE_ENV: 'development' };
    loadLocalBin(env, write('# comment\nRESEND_API_KEY=re_local\nOTHER=1\n'));
    expect(env.RESEND_API_KEY).toBe('re_local');
    expect(env.LOCAL_BIN_KEYS?.split(',').sort()).toEqual(['OTHER', 'RESEND_API_KEY']);
  });

  it('a missing file is not an error, and production never reads it', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'development' };
    loadLocalBin(env, '/nonexistent/.local.bin');
    expect(env.LOCAL_BIN_KEYS).toBeUndefined();
    const production: Record<string, string | undefined> = { NODE_ENV: 'production' };
    loadLocalBin(production, write('RESEND_API_KEY=re_local\n'));
    expect(production.RESEND_API_KEY).toBeUndefined();
  });
});

describe('app URL for links', () => {
  it('prefers APP_URL, then the production domain, then the request', () => {
    expect(appUrl('http://localhost:3000/api', { APP_URL: 'https://wa.example.com/' })).toBe('https://wa.example.com');
    expect(appUrl('https://x.vercel.app/api', { VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'wa.example.com' })).toBe('https://wa.example.com');
    expect(appUrl('http://localhost:3000/api', {})).toBe('http://localhost:3000');
  });
});

describe('§12 CSV export', () => {
  it.each(csvGolden.cases)('$id', ({ value, expect: want }) => {
    expect(protectCell(value)).toBe(want);
  });
  it('quotes commas, quotes and line breaks', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], [null, 1]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n,1\r\n');
  });
});
