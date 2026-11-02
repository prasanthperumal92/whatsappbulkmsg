import { eq, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/lib/db';
import { decrypt, encrypt, parseEncryptionKey } from './crypto';

const { settings } = schema;

export const SECRETS_KEY = 'secrets';

/** Secret names match their env vars, which take precedence (§7.1.2, §7A.1). */
export const SECRET_NAMES = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_WABA_ID',
  'WHATSAPP_PHONE_NUMBER_ID',
  'META_APP_ID',
  'META_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type CredentialSource = 'env' | 'settings' | 'none';

async function readRow(db: Tx): Promise<Partial<Record<SecretName, string>>> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SECRETS_KEY));
  return (row?.valueJson ?? {}) as Partial<Record<SecretName, string>>;
}

export async function setSecret(db: Tx, name: SecretName, value: string, rawKey = process.env.APP_ENCRYPTION_KEY) {
  const entry = { [name]: encrypt(value, parseEncryptionKey(rawKey), name) };
  // Merge in SQL so two people saving different secrets can't overwrite each other.
  await db
    .insert(settings)
    .values({ key: SECRETS_KEY, valueJson: entry })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson: sql`${settings.valueJson} || ${JSON.stringify(entry)}::jsonb` } });
}

export async function deleteSecret(db: Tx, name: SecretName) {
  await db.update(settings).set({ valueJson: sql`${settings.valueJson} - ${name}::text` }).where(eq(settings.key, SECRETS_KEY));
}

/** Env var, then the encrypted row, then nothing. Server-side only: never put the result in a response. */
export async function getSecret(db: Tx, name: SecretName, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (env[name]) return env[name]!;
  const stored = (await readRow(db))[name];
  return stored ? decrypt(stored, parseEncryptionKey(env.APP_ENCRYPTION_KEY), name) : null;
}

/** Where each credential comes from, for status displays. Reads no secret values into the result. */
export async function credentialSources(
  db: Tx,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<SecretName, CredentialSource>> {
  const row = await readRow(db);
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, env[n] ? 'env' : row[n] ? 'settings' : 'none'])) as Record<
    SecretName,
    CredentialSource
  >;
}
