import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import type { Db, Tx } from '@/lib/db';
import { appUrl } from '@/lib/env';
import { getSettings } from '@/lib/settings/store';
import { capacity, resolveAudience, selection, type Exclusion } from './audience';
import { getEmailProvider } from './provider';
import { missingSenderSettings } from './send';
import { unsubscribeSecrets } from './unsubscribe';

export const audienceRequest = z.object({ selection, include_unknown: z.boolean().default(false) });

export type EmailPreview = {
  selected: number;
  recipients: number;
  excluded: Record<Exclusion, number>;
  role_addresses: number;
  provider: 'resend' | 'mock' | null;
  /** Each of these blocks sending. */
  problems: string[];
  warnings: string[];
};

/** The checks §5.8 requires before Send is enabled. The send route repeats them, so a stale form can't get past. */
export async function prepareSend(db: Db | Tx, input: z.output<typeof audienceRequest>, requestUrl: string) {
  const settings = await getSettings(db);
  const plan = await resolveAudience(db, input.selection, settings, input.include_unknown);
  const provider = await getEmailProvider(db);
  const { secret } = unsubscribeSecrets();
  const cap = await capacity(db, settings.emailSending);
  const url = appUrl(requestUrl);

  const problems = [
    ...(provider ? [] : ['Email isn’t connected. Add your Resend API key in Settings → Email.']),
    ...missingSenderSettings(settings.email),
    ...(secret ? [] : ['EMAIL_UNSUBSCRIBE_SECRET isn’t set, so unsubscribe links can’t be created.']),
    ...(plan.recipients.length > cap.remaining ? [`This send is limited to ${cap.remaining.toLocaleString('en-IN')} more ${cap.remaining === 1 ? 'email' : 'emails'} by ${cap.label}. Select fewer contacts, or send the rest later.`] : []),
  ];
  const warnings = [
    ...(plan.role_addresses ? [`${plan.role_addresses} ${plan.role_addresses === 1 ? 'recipient is a role address' : 'recipients are role addresses'} such as info@. These bounce and complain more often.`] : []),
    ...(provider?.kind === 'resend' && /\/\/(localhost|127\.0\.0\.1)/.test(url) ? [`Unsubscribe links will point at ${url}, which recipients can’t open. Set APP_URL, or send only to yourself from here.`] : []),
  ];
  return { settings, plan, provider, secret, url, problems, warnings };
}

export function toPreview({ plan, provider, problems, warnings }: Awaited<ReturnType<typeof prepareSend>>): EmailPreview {
  const { selected, recipients, excluded, role_addresses } = plan;
  return { selected, recipients: recipients.length, excluded, role_addresses, provider: provider?.kind ?? null, problems, warnings };
}

export function refuseIfBlocked({ problems }: { problems: string[] }) {
  if (problems.length) throw new ApiError(409, 'not_ready', problems[0]!);
}
