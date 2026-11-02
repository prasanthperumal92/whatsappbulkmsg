import { describe, expect, it } from 'vitest';
import errorGolden from '../../evals/golden/error-classification.json';
import optOutGolden from '../../evals/golden/opt-out-detection.json';
import statusGolden from '../../evals/golden/status-transitions.json';
import { classifyError, ERROR_TABLE, failureFields, isRetryableByRetryFailed } from '@/lib/whatsapp/errors';
import { detectOptOut, type InboundMessage } from '@/lib/whatsapp/opt-out';
import { reduceStatus, type IncomingStatus, type MessageStatus } from '@/lib/whatsapp/status';

const AT = new Date('2026-11-02T10:00:00Z');
const EARLIER = new Date('2026-11-02T09:00:00Z');

describe('T5.4 status reducer', () => {
  type Case = { id: string; current: string; incoming: string; expect: string; note?: string };
  it.each(statusGolden.cases as Case[])('$id $current + $incoming → $expect', ({ current, incoming, expect: want }) => {
    expect(reduceStatus({ status: current as MessageStatus }, { status: incoming as IncomingStatus, at: AT }).status).toBe(want);
  });

  const reduce = (status: MessageStatus, incoming: IncomingStatus, row = {}, event = {}) => reduceStatus({ status, ...row }, { status: incoming, at: AT, ...event });

  it('ST-05 records delivered_at on a row that is already read', () => {
    expect(reduce('read', 'delivered').patch).toEqual({ delivered_at: AT });
  });
  it('keeps the first timestamp on a duplicate', () => {
    expect(reduce('read', 'read', { read_at: EARLIER }).patch).toEqual({});
  });
  it('ST-07 a duplicate of a status with no timestamp yet sets only that timestamp', () => {
    expect(reduce('read', 'read').patch).toEqual({ read_at: AT });
  });
  it('ST-17 saves the wamid from the webhook', () => {
    expect(reduce('sending', 'sent', {}, { wamid: 'wamid.1' }).patch).toEqual({ status: 'sent', sent_at: AT, wamid: 'wamid.1' });
  });
  it('never replaces a saved wamid', () => {
    expect(reduce('sent', 'delivered', { wamid: 'wamid.1' }, { wamid: 'wamid.2' }).patch).toEqual({ status: 'delivered', delivered_at: AT });
  });
  it('ST-19 sets accepted_at when the send step reports late, and keeps the status', () => {
    expect(reduce('delivered', 'engine_accepted').patch).toEqual({ accepted_at: AT });
  });
  it('the send step moves a sending row to accepted, and saves its wamid', () => {
    expect(reduce('sending', 'engine_accepted', {}, { wamid: 'w' }).patch).toEqual({ status: 'accepted', accepted_at: AT, wamid: 'w' });
  });
  it('ST-20 a failed row keeps its status but records accepted_at', () => {
    const result = reduce('failed', 'engine_accepted');
    expect(result).toMatchObject({ status: 'failed', patch: { accepted_at: AT } });
  });
  it('ST-15 a failed row records delivered_at and stays failed', () => {
    expect(reduce('failed', 'delivered').patch).toEqual({ delivered_at: AT });
  });
  it('ST-10 an ignored failure sets nothing, and runs no failure action', () => {
    const result = reduce('delivered', 'failed');
    expect(result.patch).toEqual({});
    expect(result.runFailureAction).toBe(false);
  });
  it('the failure action runs once, on the move to failed', () => {
    expect(reduce('sent', 'failed')).toMatchObject({ status: 'failed', runFailureAction: true, patch: { status: 'failed', failed_at: AT } });
    expect(reduce('failed', 'failed', { failed_at: EARLIER })).toMatchObject({ runFailureAction: false, patch: {} });
  });
  it.each(['pending', 'claimed', 'retry_wait', 'skipped'] as MessageStatus[])('ST-16 a %s row was not sent: unchanged, and reported as unmatched', (status) => {
    expect(reduce(status, 'delivered', {}, { wamid: 'w' })).toEqual({ status, patch: {}, unmatched: true, runFailureAction: false });
  });
});

describe('T5.4 error classifier', () => {
  type Case = { id: string; code?: number; http_status?: number; network_error?: string; action: string; banner?: string; max_attempts?: number; suppression_reason?: string; retryable_by_retry_failed?: boolean | string };
  it.each(errorGolden.cases as Case[])('$id', ({ code, http_status, network_error, action, banner, max_attempts, suppression_reason, retryable_by_retry_failed }) => {
    const result = classifyError({ code, http_status, network_error });
    expect(result.action).toBe(action);
    expect(result.banner).toBe(banner);
    expect(result.max_attempts).toBe(max_attempts);
    expect(result.suppression_reason).toBe(suppression_reason);
    if (retryable_by_retry_failed === false) expect(result.retry_failed).toBe('never');
    if (typeof retryable_by_retry_failed === 'string') expect(result.retry_failed).toBe('after_24h');
  });

  it('a listed code wins over its HTTP status', () => {
    expect(classifyError({ code: 190, http_status: 500 }).action).toBe('pause_campaign');
    expect(classifyError({ code: 999999, http_status: 503 }).action).toBe('retry_transient');
  });
  it('a 4xx with no code is failed, not retried', () => {
    expect(classifyError({ http_status: 400 }).action).toBe('failed');
  });
  it('G-06 an unrecognised network error is treated as possibly sent', () => {
    expect(classifyError({ network_error: 'ECONNRESET' }).action).toBe('unknown');
    expect(classifyError({ network_error: 'DNS_BEFORE_REQUEST_SENT' }).action).toBe('retry_transient');
    expect(classifyError({}).action).toBe('failed');
  });
  it('the table is data, with every code from §7.7', () => {
    expect(Object.keys(ERROR_TABLE).map(Number).sort((a, b) => a - b)).toEqual([0, 4, 10, 190, 200, 368, 80007, 130429, 131026, 131031, 131047, 131049, 131050, 131056, 132000, 132001, 132015, 132016]);
  });
  it('Retry failed: 131049 only after 24 hours, and an unlisted code never', () => {
    const failedAt = new Date('2026-11-02T00:00:00Z');
    const hours = (n: number) => new Date(failedAt.getTime() + n * 3_600_000);
    expect(isRetryableByRetryFailed(131049, failedAt, hours(23.9))).toBe(false);
    expect(isRetryableByRetryFailed(131049, failedAt, hours(24.1))).toBe(true);
    expect(isRetryableByRetryFailed(131049, null, hours(48))).toBe(false);
    expect(isRetryableByRetryFailed(131026, failedAt, hours(48))).toBe(false);
    expect(isRetryableByRetryFailed(999999, failedAt, hours(48))).toBe(false);
  });
  it('persists the same fields from an API error and a webhook error', () => {
    const fields = errorGolden.persistence.fields;
    const api = failureFields({ code: 131026, error_subcode: 5, message: 'Undeliverable', error_data: { details: 'Not on WhatsApp' }, fbtrace_id: 'abc' });
    expect(Object.keys(api).sort()).toEqual([...fields].sort());
    expect(api).toEqual({ error_code: '131026', error_subcode: '5', error_title: 'Undeliverable', error_detail: 'Not on WhatsApp', fbtrace_id: 'abc' });
    expect(failureFields({ code: 131049, title: 'Ecosystem', message: 'Longer' })).toEqual({ error_code: '131049', error_subcode: null, error_title: 'Ecosystem', error_detail: null, fbtrace_id: null });
  });
});

describe('T5.4 opt-out detector', () => {
  const { keywords } = optOutGolden;
  type Case = InboundMessage & { id: string; suppress: boolean; identity_mapping?: Record<string, string>; expect_suppressed_phone?: string | null; expect_suppressed_bsuid?: string };
  it.each(optOutGolden.cases as Case[])('$id', (c) => {
    const result = detectOptOut(c, { keywords, identityMapping: c.identity_mapping });
    expect(result.suppress).toBe(c.suppress);
    if ('expect_suppressed_phone' in c) expect(result.phone).toBe(c.expect_suppressed_phone);
    if (c.expect_suppressed_bsuid) expect(result.bsuid).toBe(c.expect_suppressed_bsuid);
  });

  const detect = (message: InboundMessage, custom = keywords) => detectOptOut(message, { keywords: custom });

  it('records the reason: stop_keyword for text, button for a quick reply', () => {
    expect(detect({ type: 'text', body: 'STOP' }).reason).toBe('stop_keyword');
    expect(detect({ type: 'button', payload: 'Stop promotions', text: 'Stop promotions' }).reason).toBe('button');
    expect(detect({ type: 'interactive', button_reply_title: 'Stop promotions' }).reason).toBe('button');
    expect(detect({ type: 'text', body: 'hello' }).reason).toBeNull();
  });
  it('a phone in the webhook becomes E.164, and wins over the BSUID', () => {
    const r = detectOptOut({ type: 'text', body: 'STOP', from: '919876543210', from_user_id: 'IN.1' }, { keywords, identityMapping: { 'IN.1': '+911111111111' } });
    expect(r).toMatchObject({ phone: '+919876543210', bsuid: null });
  });
  it('G-08 trailing emoji and spacing are ignored, and a leading word is not', () => {
    expect(detect({ type: 'text', body: 'stop 🙏🏽' }).suppress).toBe(true);
    expect(detect({ type: 'text', body: 'stop  promotions!!' }).suppress).toBe(true);
    expect(detect({ type: 'text', body: '!!!' }).suppress).toBe(false);
    expect(detect({ type: 'text', body: 'no stop' }).suppress).toBe(false);
  });
  it('uses the configured keywords, and the Stop promotions button works whatever they are', () => {
    expect(detect({ type: 'text', body: 'BAS' }, ['BAS']).suppress).toBe(true);
    expect(detect({ type: 'text', body: 'STOP' }, ['BAS']).suppress).toBe(false);
    expect(detect({ type: 'button', payload: 'Stop promotions' }, ['BAS']).suppress).toBe(true);
  });
  it('a button is matched on its payload or its text', () => {
    expect(detect({ type: 'button', payload: 'x', text: 'Stop promotions' }).suppress).toBe(true);
    expect(detect({ type: 'button', payload: 'stop promotions', text: 'x' }).suppress).toBe(true);
  });
});
