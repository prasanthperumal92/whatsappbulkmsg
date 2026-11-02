import { describe, expect, it } from 'vitest';
import payloadGolden from '../../evals/golden/send-payload.json';
import windowGolden from '../../evals/golden/send-window.json';
import { sendWindowState, type SendWindow } from '@/lib/campaigns/send-window';
import { buildSendPayload, type PayloadContact, type PayloadTemplate, type VariableMapping } from '@/lib/whatsapp/payload';

const MESSAGE_ID = payloadGolden.message_id;

describe('T5.3 payload builder', () => {
  type Case = { id: string; note: string; template: unknown; mapping: unknown; contact: unknown; expect_body?: unknown; expect_skip_reason?: string };
  const build = (template: unknown, mapping: unknown, contact: unknown) =>
    buildSendPayload(template as PayloadTemplate, mapping as VariableMapping, contact as PayloadContact, MESSAGE_ID);

  it.each(payloadGolden.cases as Case[])('$id $note', ({ template, mapping, contact, expect_body, expect_skip_reason }) => {
    const result = build(template, mapping, contact);
    if (expect_skip_reason) expect(result).toEqual({ skip_reason: expect_skip_reason });
    else expect(result).toEqual({ body: expect_body });
  });

  const welcome: PayloadTemplate = { name: 'welcome', language: 'en', parameter_format: 'NAMED', body_vars: ['first_name'] };
  const textOf = (result: ReturnType<typeof buildSendPayload>, component = 'body') => {
    if (!('body' in result)) throw new Error('skipped');
    const found = result.body.template.components?.find((c) => c.type === component);
    return (found?.parameters[0] as { text: string }).text;
  };

  it('G-14 runs of spaces become one space, and the edges are trimmed', () => {
    const result = build(welcome, { first_name: { field: 'first_name' } }, { wa_to: '91', first_name: '  Asha     Rao\r\n ' });
    expect(textOf(result)).toBe('Asha Rao');
  });

  it('a fallback is cleaned too, and a blank fallback skips the recipient', () => {
    expect(textOf(build(welcome, { first_name: { field: 'first_name', fallback: 'dear\n friend' } }, { wa_to: '91' }))).toBe('dear friend');
    expect(build(welcome, { first_name: { field: 'first_name', fallback: '   ' } }, { wa_to: '91' })).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
  });

  it('a missing mapping, a blank static value and a missing attribute all skip', () => {
    expect(build(welcome, {}, { wa_to: '91', first_name: 'A' })).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
    expect(build(welcome, { first_name: { static: ' ' } }, { wa_to: '91' })).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
    expect(build(welcome, { first_name: { attribute: 'x' } }, { wa_to: '91', attributes: {} })).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
  });

  it('an attribute falls back, and a number is sent as text', () => {
    expect(textOf(build(welcome, { first_name: { attribute: 'x', fallback: 'there' } }, { wa_to: '91', attributes: {} }))).toBe('there');
    expect(textOf(build(welcome, { first_name: { attribute: 'x' } }, { wa_to: '91', attributes: { x: 15 } }))).toBe('15');
    expect(textOf(build(welcome, { first_name: { attribute: 'x' } }, { wa_to: '91', attributes: { x: 0 } }))).toBe('0');
  });

  it('an empty URL suffix skips the recipient', () => {
    const t: PayloadTemplate = { name: 't', language: 'en', parameter_format: 'NAMED', body_vars: [], url_button_index: 1 };
    expect(build(t, { button_1: { attribute: 'code' } }, { wa_to: '91', attributes: {} })).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
    const ok = build(t, { button_1: { static: 'A1' } }, { wa_to: '91' });
    expect('body' in ok && ok.body.template.components).toEqual([{ type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'A1' }] }]);
  });

  it.each(['IMAGE', 'VIDEO', 'DOCUMENT'] as const)('a %s header uses its media id, and a missing id skips', (format) => {
    const t: PayloadTemplate = { name: 't', language: 'en', parameter_format: 'NAMED', body_vars: [], header_format: format };
    const key = format.toLowerCase();
    const ok = build(t, { header: { media_id: 'm1' } }, { wa_to: '91' });
    expect('body' in ok && ok.body.template.components).toEqual([{ type: 'header', parameters: [{ type: key, [key]: { id: 'm1' } }] }]);
    expect(build(t, {}, { wa_to: '91' })).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
  });

  it('a text header variable is sent, named or positional, and a static text header sends nothing', () => {
    const named: PayloadTemplate = { name: 't', language: 'en', parameter_format: 'NAMED', body_vars: [], header_format: 'TEXT', header_var: 'city' };
    const ok = build(named, { header: { field: 'city' } }, { wa_to: '91', city: 'Pune' });
    expect('body' in ok && ok.body.template.components).toEqual([{ type: 'header', parameters: [{ type: 'text', parameter_name: 'city', text: 'Pune' }] }]);
    const positional = build({ ...named, parameter_format: 'POSITIONAL', header_var: '1' }, { header: { field: 'city' } }, { wa_to: '91', city: 'Pune' });
    expect('body' in positional && positional.body.template.components).toEqual([{ type: 'header', parameters: [{ type: 'text', text: 'Pune' }] }]);
    const fixed = build({ ...named, header_var: undefined }, {}, { wa_to: '91' });
    expect('body' in fixed && fixed.body.template.components).toBeUndefined();
    expect(build(named, { header: { field: 'city' } }, { wa_to: '91' })).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
  });
});

describe('T5.3 send window', () => {
  const window: SendWindow & { tz: string } = windowGolden.window;
  type Case = { id: string; now: string; scheduled_at?: string; zones?: string[]; open_zones?: string[]; wait_until: string | null; note?: string };

  it.each(windowGolden.cases as Case[])('$id $note', ({ now, scheduled_at, zones, open_zones, wait_until }) => {
    const state = sendWindowState({
      now: new Date(now),
      zones: zones ?? [window.tz],
      window,
      scheduledAt: scheduled_at ? new Date(scheduled_at) : null,
    });
    expect(state.waitUntil?.getTime() ?? null).toBe(wait_until ? new Date(wait_until).getTime() : null);
    if (open_zones) expect(state.openZones).toEqual(open_zones);
  });

  const at = (now: string, zones: string[], extra: Partial<Parameters<typeof sendWindowState>[0]> = {}) =>
    sendWindowState({ now: new Date(now), zones, window, ...extra });

  it('FR-CMP-08 at 21:00 IST, India waits until 09:00 IST and London is open', () => {
    const state = at('2026-11-02T15:30:00Z', ['Asia/Kolkata', 'Europe/London']);
    expect(state.openZones).toEqual(['Europe/London']);
    expect(state.waitUntil).toBeNull();
    expect(at('2026-11-02T15:30:00Z', ['Asia/Kolkata']).waitUntil?.toISOString()).toBe('2026-11-03T03:30:00.000Z');
  });

  it('seconds count: just before the end is open, just before the start waits for the exact start', () => {
    expect(at('2026-11-02T14:29:59Z', ['Asia/Kolkata']).openZones).toEqual(['Asia/Kolkata']);
    expect(at('2026-11-02T03:29:59Z', ['Asia/Kolkata']).waitUntil?.toISOString()).toBe('2026-11-02T03:30:00.000Z');
  });

  it('nothing is open before a future scheduled time, even in an open zone', () => {
    const state = at('2026-11-02T05:00:00Z', ['Asia/Kolkata'], { scheduledAt: new Date('2026-11-02T08:30:00Z') });
    expect(state.openZones).toEqual([]);
  });

  it('a scheduled time in the past changes nothing', () => {
    const state = at('2026-11-02T05:00:00Z', ['Asia/Kolkata'], { scheduledAt: new Date('2026-11-01T05:00:00Z') });
    expect(state).toEqual({ openZones: ['Asia/Kolkata'], waitUntil: null });
  });

  it('a scheduled time with several zones waits for the earliest open window after it', () => {
    const state = at('2026-11-02T05:00:00Z', ['Asia/Kolkata', 'Europe/London'], { scheduledAt: new Date('2026-11-02T15:30:00Z') });
    expect(state.waitUntil?.toISOString()).toBe('2026-11-02T15:30:00.000Z'); // 15:30 in London is open
  });

  it('a clock change the next morning: the wait uses the next day\'s offset', () => {
    // US clocks go forward on 8 March 2026. At 21:00 CST on the 7th the next 09:00 is CDT.
    expect(at('2026-03-08T03:00:00Z', ['America/Chicago']).waitUntil?.toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('a start time skipped by a clock change moves forward by the size of the change', () => {
    const early: SendWindow = { start: '02:30', end: '20:00' };
    // 02:30 doesn't exist in Chicago on 8 March 2026, so it becomes 03:30 CDT.
    const state = sendWindowState({ now: new Date('2026-03-08T07:30:00Z'), zones: ['America/Chicago'], window: early });
    expect(state.waitUntil?.toISOString()).toBe('2026-03-08T08:30:00.000Z');
  });

  it('a window across midnight stays open past midnight, with an exclusive end', () => {
    const late: SendWindow = { start: '22:00', end: '02:00', tz: 'Asia/Kolkata' };
    const state = (now: string) => sendWindowState({ now: new Date(now), zones: ['Asia/Kolkata'], window: late });
    expect(state('2026-11-02T18:00:00Z').openZones).toEqual(['Asia/Kolkata']); // 23:30
    expect(state('2026-11-02T20:00:00Z').openZones).toEqual(['Asia/Kolkata']); // 01:30
    expect(state('2026-11-02T20:30:00Z').waitUntil?.toISOString()).toBe('2026-11-03T16:30:00.000Z'); // 02:00 → 22:00
  });

  it('no zones means nothing to wait for', () => {
    expect(at('2026-11-02T05:00:00Z', [])).toEqual({ openZones: [], waitUntil: null });
  });
});
