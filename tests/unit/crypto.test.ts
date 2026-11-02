import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, parseEncryptionKey } from '@/lib/settings/crypto';

const key = randomBytes(32);

describe('T1.8 AES-256-GCM', () => {
  it.each(['EAAtoken', '', 'ünï©ødé ✓', 'x'.repeat(5000)])('round-trips %#', (plain) => {
    expect(decrypt(encrypt(plain, key, 'NAME'), key, 'NAME')).toBe(plain);
  });

  it('uses a fresh IV and never contains the plaintext', () => {
    const a = encrypt('EAAtoken', key, 'NAME');
    expect(a).not.toBe(encrypt('EAAtoken', key, 'NAME'));
    expect(a).not.toContain('EAAtoken');
  });

  it('rejects a wrong key, a tampered value and a value moved to another slot', () => {
    const enc = encrypt('secret', key, 'A');
    expect(() => decrypt(enc, randomBytes(32), 'A')).toThrow();
    expect(() => decrypt(enc, key, 'B')).toThrow();
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), key, 'A')).toThrow();
    expect(() => decrypt('nonsense', key, 'A')).toThrow();
  });

  it('validates the key length', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow();
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow();
    expect(parseEncryptionKey(key.toString('base64'))).toHaveLength(32);
  });
});
