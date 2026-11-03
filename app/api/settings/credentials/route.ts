import { z } from 'zod';
import { ApiError, parseJson } from '@/lib/api/errors';
import { withAudit, withSession } from '@/lib/api/route';
import type { Tx } from '@/lib/db';
import { LOCAL_BIN_KEYS } from '@/lib/local-bin';
import { credentialSources, deleteSecret, setSecret } from '@/lib/settings/secrets';

const accountId = z.string().trim().regex(/^\d+$/, 'This ID is made of digits only').nullable().optional();
const body = z.object({
  WHATSAPP_ACCESS_TOKEN: z.string().trim().regex(/^\S{20,}$/, 'That doesn’t look like an access token. Paste the whole token, with no spaces.').nullable().optional(),
  WHATSAPP_WABA_ID: accountId,
  WHATSAPP_PHONE_NUMBER_ID: accountId,
  META_APP_SECRET: z.string().trim().regex(/^\S{16,}$/, 'That doesn’t look like an App Secret. Copy it from App settings → Basic.').nullable().optional(),
  RESEND_API_KEY: z.string().trim().regex(/^re_\S+$/, 'A Resend API key starts with re_').nullable().optional(),
  RESEND_WEBHOOK_SECRET: z.string().trim().regex(/^whsec_\S+$/, 'A webhook signing secret starts with whsec_').nullable().optional(),
});
const NAMES = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_WABA_ID', 'WHATSAPP_PHONE_NUMBER_ID', 'META_APP_SECRET', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET'] as const;

/** Where each credential comes from. Never its value. */
async function describe(db: Tx) {
  const sources = await credentialSources(db);
  const fromFile = (process.env[LOCAL_BIN_KEYS] ?? '').split(',');
  return Object.fromEntries(NAMES.map((n) => [n, sources[n] === 'env' && fromFile.includes(n) ? 'local_bin' : sources[n]]));
}

export const GET = withSession(async (_req, { db }) => Response.json(await describe(db)));

/** §9: write-only. A value saves it, and null removes it. */
export const PUT = withAudit({ action: 'credentials.update', entity: 'settings' }, async (req, { tx, audit }) => {
  const input = await parseJson(req, body);
  const changed = NAMES.filter((n) => input[n] !== undefined);
  if (!changed.length) throw new ApiError(400, 'nothing_to_change', 'Enter a value to save.');
  for (const name of changed) {
    const value = input[name];
    if (value) await setSecret(tx, name, value);
    else await deleteSecret(tx, name);
  }
  audit({ details: { changed } });
  return Response.json(await describe(tx));
});
