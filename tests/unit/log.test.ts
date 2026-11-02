import { describe, expect, it } from 'vitest';
import { createLogger, sanitize, scrubString } from '@/lib/log';

function capture() {
  const lines: string[] = [];
  return { logger: createLogger((l) => lines.push(l)), lines };
}

describe('T1.7 safe logging', () => {
  it('SEC-10 masks a phone in a send error, with no token or full number', () => {
    const { logger, lines } = capture();
    logger.error('Send failed for +919876543210', {
      phone: '+919876543210',
      wa_to: '919876543210',
      access_token: 'EAAabcdefghijklmnop',
      url: 'https://graph.facebook.com/v26.0/1/messages?x=EAAabcdefghijklmnop',
      headers: { Authorization: 'Bearer abc.def' },
    });
    const line = lines[0]!;
    expect(line).toContain('+91******3210');
    expect(line).not.toContain('919876543210');
    expect(line).not.toContain('EAAabcdefghijklmnop');
    expect(line).not.toContain('abc.def');
  });

  it('SEC-18 masks an email in a bounce log', () => {
    const { logger, lines } = capture();
    logger.warn('Bounce', { to: 'asha@example.com', text: 'hard bounce for asha@example.com' });
    expect(lines[0]).toContain('a••••@example.com');
    expect(lines[0]).not.toContain('asha@');
  });

  it.each([
    ['Resend key', 'key re_abc123_DEF456 used', 're_abc123_DEF456'],
    ['webhook secret', 'whsec_abcDEF123=', 'whsec_abcDEF123'],
    ['Clerk secret', 'sk_test_abcdef123', 'sk_test_abcdef123'],
    ['Postgres password', 'connect postgres://user:hunter2@db.neon.tech/x failed', 'hunter2'],
    ['spaced phone', 'to +91 98765 43210 failed', '98765'],
  ])('redacts a %s inside free text', (_n, input, secret) => {
    expect(scrubString(input)).not.toContain(secret);
  });

  it.each(['token', 'run_token', 'app_secret', 'API_KEY', 'apiKey', 'Authorization', 'cookie', 'password', 'svix-signature'])(
    'redacts the value of key %s',
    (key) => {
      expect(sanitize({ [key]: 'plain-value' })).toEqual({ [key]: '[REDACTED]' });
    },
  );

  it('masks a phone field in any format, including raw CSV values', () => {
    expect(sanitize({ phone: '098765 43210', raw_mobile: '98765-43210', wa_to: '919876543210' })).toEqual({
      phone: '09*****3210',
      raw_mobile: '98****3210',
      wa_to: '91******3210',
    });
  });

  it('leaves ordinary values alone', () => {
    const input = {
      id: '01900000-0000-7000-8000-00000000000a',
      at: '2026-11-02T10:15:30.123+05:30',
      batch: 100,
      error_code: '131050',
      idempotency_key: 'abc',
      epoch: 1793000000000,
    };
    expect(sanitize(input)).toEqual(input);
  });

  it('scrubs nested values, arrays and errors, and survives cycles', () => {
    const err = new Error('failed for a@b.co');
    const cyc: Record<string, unknown> = { to: ['+919876543210'], nested: { secret: 'x' }, err };
    cyc.self = cyc;
    const out = JSON.stringify(sanitize(cyc));
    expect(out).toContain('[Circular]');
    expect(out).not.toContain('a@b.co');
    expect(out).not.toContain('919876543210');
    expect(out).not.toContain('"secret":"x"');
  });
});
