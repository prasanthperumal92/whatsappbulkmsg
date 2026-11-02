import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM for the `secrets` settings row (§7.1.2). Format: v1.<iv>.<tag>.<ciphertext>, base64url.
// `context` is bound as additional data, so a value can't be moved to another secret's slot.

const VERSION = 'v1';

export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('APP_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

export function encrypt(plaintext: string, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decrypt(payload: string, key: Buffer, context: string): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error('Malformed encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
