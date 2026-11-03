import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ContactRow } from '@/lib/contacts/store';
import { planWhatsAppAudience, tierLimit } from '@/lib/whatsapp/audience';
import { buildSendPayload } from '@/lib/whatsapp/payload';
import { createGraphProvider, WhatsAppApiError } from '@/lib/whatsapp/provider';
import { renderBody, templateShape } from '@/lib/whatsapp/template-shape';
import { verifyMetaSignature } from '@/lib/whatsapp/webhook';

const contact = (id: string, fields: Partial<ContactRow> = {}) => ({ contact_id: id, phone_e164: '+919876543210', wa_to: '919876543210', country_iso: 'IN', opt_in_status: 'opted_in', is_deleted: false, ...fields }) as ContactRow;
const plan = (contacts: ContactRow[], extra: Partial<Parameters<typeof planWhatsAppAudience>[0]> = {}) =>
  planWhatsAppAudience({ contacts, suppressed: new Set(), lastMessaged: new Map(), frequencyCapDays: 7, unknownConsentLimit: 500, strictConsentCountries: ['GB'], restrictedCountries: ['US'], includeUnknown: false, now: new Date('2026-11-03T00:00:00Z'), ...extra });

describe('WhatsApp audience', () => {
  it('leaves people out for each reason, and counts them', () => {
    const result = plan(
      [
        contact('a'),
        contact('b', { phone_e164: null, wa_to: null }),
        contact('c', { phone_e164: '+911' }),
        contact('d', { opt_in_status: 'opted_out' }),
        contact('e', { country_iso: 'US' }),
        contact('f', { opt_in_status: 'unknown' }),
        contact('g', { is_deleted: true }),
        contact('h'),
      ],
      { suppressed: new Set(['+911']), lastMessaged: new Map([['h', new Date('2026-11-01T00:00:00Z')]]) },
    );
    expect(result.recipients.map((c) => c.contact_id)).toEqual(['a']);
    expect(result.excluded).toMatchObject({ no_phone: 1, suppressed: 1, opted_out: 1, restricted_country: 1, unknown_consent: 1, deleted: 1, frequency_cap: 1 });
  });

  it('keeps strict-consent countries out even when unknown consent is included, and honours the limit', () => {
    const result = plan([contact('a', { opt_in_status: 'unknown' }), contact('b', { opt_in_status: 'unknown' }), contact('c', { opt_in_status: 'unknown', country_iso: 'GB' }), contact('d', { opt_in_status: 'unknown', country_iso: null })], { includeUnknown: true, unknownConsentLimit: 1 });
    expect(result.recipients.map((c) => c.contact_id)).toEqual(['a']);
    expect(result.excluded.unknown_consent).toBe(3);
  });

  it('reads the messaging limit tier', () => {
    expect(tierLimit('TIER_250')).toBe(250);
    expect(tierLimit('TIER_2K')).toBe(2000);
    expect(tierLimit('TIER_UNLIMITED')).toBeNull();
    expect(tierLimit(null)).toBeNull();
  });
});

describe('templateShape', () => {
  it('reads named variables, a text header and a dynamic link', () => {
    const shape = templateShape({
      name: 'offer',
      language: 'en',
      category: 'MARKETING',
      parameter_format: 'NAMED',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'For {{company}}' },
        { type: 'BODY', text: 'Hi {{first_name}}, {{discount}} off. Hi again {{first_name}}.' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }, { type: 'URL', text: 'View', url: 'https://example.com/{{1}}' }] },
      ],
    });
    expect(shape.unsupported).toBeNull();
    expect(shape.payload).toMatchObject({ parameter_format: 'NAMED', body_vars: ['first_name', 'discount'], header_format: 'TEXT', header_var: 'company', url_button_index: 1 });
    expect(shape.slots.map((s) => s.key)).toEqual(['header', 'first_name', 'discount', 'button_1']);
  });

  it('treats numbered variables as positional when Meta omits the format', () => {
    expect(templateShape({ name: 'x', language: 'en', components: [{ type: 'BODY', text: 'Hi {{1}}, see {{2}} now' }] }).payload).toMatchObject({ parameter_format: 'POSITIONAL', body_vars: ['1', '2'] });
  });

  it('sends a template with no variables, such as hello_world, with no components', () => {
    const { payload } = templateShape({ name: 'hello_world', language: 'en_US', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello World' }] });
    const built = buildSendPayload(payload, {}, { wa_to: '919876543210' }, 'id-1');
    expect(built).toMatchObject({ body: { to: '919876543210', biz_opaque_callback_data: 'id-1', template: { name: 'hello_world', language: { code: 'en_US' } } } });
    expect('body' in built && built.body.template.components).toBeUndefined();
  });

  it('sends a media header from a link', () => {
    const { payload } = templateShape({ name: 'x', language: 'en', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Look at this' }] });
    expect(buildSendPayload(payload, {}, { wa_to: '1' }, 'id')).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
    const built = buildSendPayload(payload, { header: { media_link: 'https://example.com/a.jpg' } }, { wa_to: '1' }, 'id');
    expect('body' in built && built.body.template.components).toEqual([{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://example.com/a.jpg' } }] }]);
  });

  it.each([
    ['one-time passwords', { category: 'AUTHENTICATION', components: [{ type: 'BODY', text: 'Code {{1}}' }] }],
    ['carousels', { components: [{ type: 'BODY', text: 'x' }, { type: 'CAROUSEL' }] }],
    ['copy-code buttons', { components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }] }] }],
    ['location headers', { components: [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'x' }] }],
    ['two dynamic links', { components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://a/{{1}}' }, { type: 'URL', url: 'https://b/{{1}}' }] }] }],
  ])('marks %s as unsupported', (_name, fields) => {
    expect(templateShape({ name: 'x', language: 'en', ...fields }).unsupported).toBeTruthy();
  });

  it('renders a preview, leaving an unfilled variable visible', () => {
    expect(renderBody('Hi {{first_name}}, {{discount}} off', (v) => (v === 'first_name' ? 'Asha' : null))).toBe('Hi Asha, {{discount}} off');
  });
});

describe('verifyMetaSignature', () => {
  const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  it('accepts only the exact body and secret', () => {
    expect(verifyMetaSignature('{"a":1}', sign('{"a":1}', 's3cret'), 's3cret')).toBe(true);
    expect(verifyMetaSignature('{"a": 1}', sign('{"a":1}', 's3cret'), 's3cret')).toBe(false);
    expect(verifyMetaSignature('{"a":1}', sign('{"a":1}', 'other'), 's3cret')).toBe(false);
    expect(verifyMetaSignature('{"a":1}', null, 's3cret')).toBe(false);
    expect(verifyMetaSignature('{"a":1}', 'garbage', 's3cret')).toBe(false);
  });
});

describe('WhatsAppApiError.rule', () => {
  it('uses the shared table', () => {
    expect(new WhatsAppApiError('x', 400, { code: 131050 }).rule.action).toBe('failed_and_suppress');
    expect(new WhatsAppApiError('x', null, null, 'ECONNREFUSED_BEFORE_REQUEST_SENT').rule.action).toBe('retry_transient');
    expect(new WhatsAppApiError('x', null, null, 'TIMEOUT').rule.action).toBe('unknown');
  });
});

describe('createGraphProvider', () => {
  it('won’t send the token to a paging link on another host', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return Response.json({ data: [], paging: { next: 'https://evil.example.com/next' } });
    }) as typeof fetch;
    try {
      await createGraphProvider({ token: 't', wabaId: '1', phoneNumberId: '2', version: 'v26.0', sendEndpoint: '/messages' }).listTemplates();
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(1);
  });
});
