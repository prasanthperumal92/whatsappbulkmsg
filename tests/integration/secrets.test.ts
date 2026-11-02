import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, schema } from '@/lib/db';
import { credentialSources, deleteSecret, getSecret, setSecret } from '@/lib/settings/secrets';
import { getSettings } from '@/lib/settings/store';
import { resetDb } from '../support/reset';

const db = getDb();
const KEY = randomBytes(32).toString('base64');
const env = { APP_ENCRYPTION_KEY: KEY };

beforeEach(async () => {
  await resetDb();
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
});

describe('T1.8 secrets store', () => {
  it('stores ciphertext and reads back the value', async () => {
    await setSecret(db, 'RESEND_API_KEY', 're_plaintext123');
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'secrets'));
    expect(JSON.stringify(row)).not.toContain('re_plaintext123');
    expect(await getSecret(db, 'RESEND_API_KEY', env)).toBe('re_plaintext123');
  });

  it('env var beats the Settings row beats nothing', async () => {
    expect(await getSecret(db, 'RESEND_API_KEY', env)).toBeNull();
    expect((await credentialSources(db, env)).RESEND_API_KEY).toBe('none');
    await setSecret(db, 'RESEND_API_KEY', 're_fromsettings');
    expect((await credentialSources(db, env)).RESEND_API_KEY).toBe('settings');
    const withEnv = { ...env, RESEND_API_KEY: 're_fromenv' };
    expect(await getSecret(db, 'RESEND_API_KEY', withEnv)).toBe('re_fromenv');
    expect((await credentialSources(db, withEnv)).RESEND_API_KEY).toBe('env');
  });

  it('keeps other secrets when one changes, and deletes one at a time', async () => {
    await Promise.all([setSecret(db, 'RESEND_API_KEY', 'a'), setSecret(db, 'META_APP_SECRET', 'b')]);
    await setSecret(db, 'RESEND_API_KEY', 'c');
    expect(await getSecret(db, 'META_APP_SECRET', env)).toBe('b');
    await deleteSecret(db, 'META_APP_SECRET');
    expect(await getSecret(db, 'META_APP_SECRET', env)).toBeNull();
    expect(await getSecret(db, 'RESEND_API_KEY', env)).toBe('c');
  });

  it('getSettings never includes the secrets row', async () => {
    await setSecret(db, 'RESEND_API_KEY', 're_plaintext123');
    const all = await getSettings(db);
    expect(Object.keys(all)).not.toContain('secrets');
    expect(JSON.stringify(all)).not.toContain('v1.');
  });
});
