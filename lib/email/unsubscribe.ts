// §7A.5: token = base64url(message_id) + "." + base64url(HMAC-SHA256(secret, message_id)), with no padding.
// Tokens never expire, and old secrets keep verifying after a rotation, because unsubscribe links must keep working.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type TokenResult = { valid: false } | { valid: true; is_test: false; message_id: string } | { valid: true; is_test: true };

const TEST_PREFIX = 'test:';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const hmac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest();

export function signToken(value: string, secret: string): string {
  return `${Buffer.from(value).toString('base64url')}.${hmac(secret, value).toString('base64url')}`;
}

/** A test email's token verifies and shows the page, but the unsubscribe route must write nothing for it. */
export const signTestToken = (secret: string, random: string = randomUUID()) => signToken(`${TEST_PREFIX}${random}`, secret);

export function verifyToken(token: string, secret: string, previousSecrets: string[] = []): TokenResult {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((p) => BASE64URL.test(p))) return { valid: false };
  const value = Buffer.from(parts[0]!, 'base64url').toString();
  const signature = Buffer.from(parts[1]!, 'base64url');
  // Only the exact encoding is accepted, so one signature can't be spelled several ways.
  if (Buffer.from(value).toString('base64url') !== parts[0] || signature.toString('base64url') !== parts[1]) return { valid: false };

  let matched = false;
  for (const candidate of [secret, ...previousSecrets]) {
    const expected = hmac(candidate, value);
    if (expected.length === signature.length && timingSafeEqual(expected, signature)) matched = true;
  }
  if (!matched) return { valid: false };
  return value.startsWith(TEST_PREFIX) ? { valid: true, is_test: true } : { valid: true, is_test: false, message_id: value };
}
