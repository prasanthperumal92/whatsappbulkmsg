import { describe, expect, it } from 'vitest';
import { isExemptApiPath } from '@/lib/auth/public-paths';

describe('§9 exempt API paths', () => {
  it.each(['/api/webhooks/whatsapp', '/api/webhooks/resend', '/api/cron/cleanup'])('%s is exempt', (p) => {
    expect(isExemptApiPath(p)).toBe(true);
  });

  it.each(['/api/webhooks', '/api/webhooksfoo', '/api/cronx', '/api/team', '/api/settings/cron/x'])('%s is not exempt', (p) => {
    expect(isExemptApiPath(p)).toBe(false);
  });
});
