import { describe, expect, it } from 'vitest';
import { channelModes, computeBanners } from '@/lib/status';
import { SECRET_NAMES, type CredentialSource, type SecretName } from '@/lib/settings/secrets';

const none = Object.fromEntries(SECRET_NAMES.map((n) => [n, 'none'])) as Record<SecretName, CredentialSource>;
const meta = { WHATSAPP_ACCESS_TOKEN: 'env', WHATSAPP_WABA_ID: 'env', WHATSAPP_PHONE_NUMBER_ID: 'settings' } as const;
const mock = { whatsapp: 'mock', email: 'mock' } as const;
const ids = (input: Parameters<typeof channelModes>[0]) => computeBanners(channelModes(input)).map((b) => b.id);

describe('T1.6 banners', () => {
  it('previews always show Mock on both channels, even with credentials present', () => {
    const banners = ['whatsapp-mock', 'email-mock'];
    expect(ids({ environment: 'preview', sources: none, localProvider: mock })).toEqual(banners);
    expect(ids({ environment: 'preview', sources: { ...none, ...meta, RESEND_API_KEY: 'env' }, localProvider: { whatsapp: 'graph', email: 'resend' } })).toEqual(banners);
  });

  it('production without credentials shows not connected and never Mock', () => {
    expect(ids({ environment: 'production', sources: none, localProvider: mock })).toEqual(['whatsapp-not-connected', 'email-not-connected']);
  });

  it('production with credentials shows no banner', () => {
    expect(ids({ environment: 'production', sources: { ...none, ...meta, RESEND_API_KEY: 'settings' }, localProvider: mock })).toEqual([]);
  });

  it('partial WhatsApp credentials count as not connected', () => {
    expect(ids({ environment: 'production', sources: { ...none, WHATSAPP_ACCESS_TOKEN: 'env', RESEND_API_KEY: 'env' }, localProvider: mock })).toEqual(['whatsapp-not-connected']);
  });

  it('local dev uses Mock until told otherwise, and a Resend key moves email off Mock (FR-SET-06)', () => {
    expect(ids({ environment: 'local', sources: none, localProvider: mock })).toEqual(['whatsapp-mock', 'email-mock']);
    expect(ids({ environment: 'local', sources: { ...none, RESEND_API_KEY: 'env' }, localProvider: mock })).toEqual(['whatsapp-mock']);
    expect(ids({ environment: 'local', sources: none, localProvider: { whatsapp: 'graph', email: 'resend' } })).toEqual(['whatsapp-not-connected', 'email-not-connected']);
  });

  it('banner wording matches §5.1', () => {
    const [whatsapp, email] = computeBanners({ whatsapp: 'not_connected', email: 'not_connected' });
    expect(whatsapp?.text).toContain('WhatsApp not connected');
    expect(whatsapp?.href).toBe('/settings');
    expect(email?.text).toContain('RESEND_API_KEY');
    expect(computeBanners(mock).map((b) => b.text)).toEqual(['Mock mode — messages are simulated.', 'Email mock mode — emails are simulated.']);
  });
});
