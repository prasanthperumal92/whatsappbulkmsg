import { describe, expect, it } from 'vitest';
import { defaultSettings, settingsSchema } from '@/lib/settings/schema';

// T1.8: defaults match SPEC §5.2.
describe('settings defaults', () => {
  const d = defaultSettings();

  it('WhatsApp sending (§5.2 item 3)', () => {
    expect(d.whatsappSending).toMatchObject({
      messagesPerSecond: 20,
      frequencyCapDays: 7,
      sendWindow: { start: '09:00', end: '20:00' },
      sendEndpoint: '/messages',
      restrictedCountries: ['US'],
      circuitBreakerFailurePercent: 25,
    });
    expect(settingsSchema.whatsappSending.safeParse({ messagesPerSecond: 81 }).success).toBe(false);
  });

  it('email sending (§5.2 item 2)', () => {
    expect(d.emailSending).toMatchObject({
      batchRequestsPerSecond: 2,
      dailyCap: 100,
      monthlyCap: 3000,
      hourlyCap: 5000,
      stagedSending: true,
      newDomainRamp: true,
      frequencyCapDays: 7,
      sendWindow: { start: '09:00', end: '20:00' },
      bounceRatePercent: 5,
      complaintRatePercent: 0.3,
    });
    expect(settingsSchema.emailSending.safeParse({ batchRequestsPerSecond: 11 }).success).toBe(false);
  });

  it('import (§5.2 item 4)', () => {
    expect(d.import).toEqual({
      defaultCountry: 'IN',
      fallbackTimeZone: 'Asia/Kolkata',
      defaultWhatsappOptIn: 'unknown',
      defaultEmailOptIn: 'unknown',
      existingContactPolicy: 'fill_empty',
      maxFileSizeMb: 50,
    });
  });

  it('data and audience rules (§5.2 items 6–7, §12A)', () => {
    expect(d.data.optOutKeywords).toEqual(['STOP', 'UNSUBSCRIBE', 'STOP PROMOTIONS']);
    expect(d.audience.unknownConsentLimit).toBe(500);
    for (const c of ['DE', 'FR', 'NO', 'IS', 'LI', 'GB', 'GG', 'JE', 'IM', 'CA']) expect(d.audience.strictConsentCountries).toContain(c);
    expect(d.audience.strictConsentCountries).toHaveLength(35);
    expect(d.audience.strictConsentCountries).not.toContain('IN');
  });

  it('refuses unknown keys, so a secret cannot be stored as a setting', () => {
    expect(settingsSchema.whatsapp.safeParse({ accessToken: 'EAAtoken' }).success).toBe(false);
  });
});
