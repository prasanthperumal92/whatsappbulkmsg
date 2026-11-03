import { ApiError, parseJson } from '@/lib/api/errors';
import { withAudit } from '@/lib/api/route';
import { appUrl } from '@/lib/env';
import { COMPOSE_MAPPING, composition, toTemplate } from '@/lib/email/compose';
import { buildEmailElement } from '@/lib/email/payload';
import { EmailProviderError, getEmailProvider } from '@/lib/email/provider';
import { emailSettingsFrom, missingSenderSettings } from '@/lib/email/send';
import { unsubscribeSecrets } from '@/lib/email/unsubscribe';
import { getSettings } from '@/lib/settings/store';

const SAMPLE = { first_name: 'Asha', last_name: 'Rao', company: 'Example Exports', city: 'Kochi' };

/** §7A.5: goes to the person sending, with `[TEST]` in the subject and a link that verifies but writes nothing. */
export const POST = withAudit({ action: 'email.test', entity: 'campaign' }, async (req, { user, tx, audit }) => {
  const input = await parseJson(req, composition);
  const template = toTemplate(input);
  const settings = await getSettings(tx);
  const provider = await getEmailProvider(tx);
  const { secret } = unsubscribeSecrets();
  const missing = missingSenderSettings(settings.email);
  if (!provider) throw new ApiError(409, 'not_ready', 'Email isn’t connected. Add your Resend API key in Settings → Email.');
  if (missing.length) throw new ApiError(409, 'not_ready', missing[0]!);
  if (!secret) throw new ApiError(409, 'not_ready', 'EMAIL_UNSUBSCRIBE_SECRET isn’t set, so unsubscribe links can’t be created.');
  if (!user.email) throw new ApiError(409, 'no_address', 'Your account has no email address to send a test to.');

  const built = await buildEmailElement({ template, mapping: COMPOSE_MAPPING, contact: { email: user.email, ...SAMPLE }, settings: emailSettingsFrom(settings, appUrl(req.url)), secret, test_send: true });
  if (!('element' in built)) throw new ApiError(409, 'not_ready', 'This email couldn’t be built for your address.');
  try {
    await provider.sendOne(built.element);
  } catch (err) {
    if (err instanceof EmailProviderError) throw new ApiError(502, 'send_failed', `Resend refused the test email: ${err.message}`);
    throw err;
  }
  audit({ channel: 'email', details: { provider: provider.kind } });
  return Response.json({ to: user.email, provider: provider.kind });
});
