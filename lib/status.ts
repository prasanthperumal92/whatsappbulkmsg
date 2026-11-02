import { getEnvironment, type AppEnvironment } from '@/lib/env';
import { credentialSources, type CredentialSource, type SecretName } from '@/lib/settings/secrets';
import { getSettingsSection } from '@/lib/settings/store';
import type { Tx } from '@/lib/db';

export type Banner = {
  id: string;
  tone: 'warning' | 'info';
  text: string;
  href?: string;
  linkText?: string;
};

export type ChannelMode = 'mock' | 'connected' | 'not_connected';
export type AppStatus = { environment: AppEnvironment; whatsapp: ChannelMode; email: ChannelMode; banners: Banner[] };

const WHATSAPP_REQUIRED: SecretName[] = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_WABA_ID', 'WHATSAPP_PHONE_NUMBER_ID'];

type StatusInput = {
  environment: AppEnvironment;
  sources: Record<SecretName, CredentialSource>;
  localProvider: { whatsapp: 'graph' | 'mock'; email: 'resend' | 'mock' };
};

/** §3.5: which provider each channel is using, as far as the user is concerned. */
export function channelModes({ environment, sources, localProvider }: StatusInput) {
  const hasWhatsApp = WHATSAPP_REQUIRED.every((n) => sources[n] !== 'none');
  const hasEmail = sources.RESEND_API_KEY !== 'none';
  if (environment === 'preview') return { whatsapp: 'mock', email: 'mock' } as const;
  if (environment === 'production') {
    return { whatsapp: hasWhatsApp ? 'connected' : 'not_connected', email: hasEmail ? 'connected' : 'not_connected' } as const;
  }
  return {
    whatsapp: localProvider.whatsapp === 'mock' ? 'mock' : hasWhatsApp ? 'connected' : 'not_connected',
    // §5.2: on local dev a key in the environment moves email off Mock with no other change (FR-SET-06).
    email: hasEmail ? 'connected' : localProvider.email === 'mock' ? 'mock' : 'not_connected',
  } as const;
}

/** §5.1 banners. Later phases add the domain, snapshot and sending banners here. */
export function computeBanners(modes: { whatsapp: ChannelMode; email: ChannelMode }): Banner[] {
  const settings = { href: '/settings', linkText: 'Open Settings' };
  const banners: Banner[] = [];
  if (modes.whatsapp === 'not_connected') {
    banners.push({ id: 'whatsapp-not-connected', tone: 'warning', text: 'WhatsApp not connected — sending and template submission are disabled.', ...settings });
  }
  if (modes.email === 'not_connected') {
    banners.push({ id: 'email-not-connected', tone: 'warning', text: 'Email not connected — add RESEND_API_KEY to .local.bin (local) or Settings → Email.', ...settings });
  }
  if (modes.whatsapp === 'mock') banners.push({ id: 'whatsapp-mock', tone: 'info', text: 'Mock mode — messages are simulated.' });
  if (modes.email === 'mock') banners.push({ id: 'email-mock', tone: 'info', text: 'Email mock mode — emails are simulated.' });
  return banners;
}

export async function getAppStatus(db: Tx, env: Record<string, string | undefined> = process.env): Promise<AppStatus> {
  const environment = getEnvironment(env);
  const [sources, whatsapp, email] = await Promise.all([
    credentialSources(db, env),
    getSettingsSection(db, 'whatsapp'),
    getSettingsSection(db, 'email'),
  ]);
  const modes = channelModes({ environment, sources, localProvider: { whatsapp: whatsapp.provider, email: email.provider } });
  return { environment, ...modes, banners: computeBanners(modes) };
}
