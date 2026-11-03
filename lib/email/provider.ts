import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import type { Tx } from '@/lib/db';
import { getEnvironment } from '@/lib/env';
import { credentialSources, getSecret } from '@/lib/settings/secrets';
import { getSettingsSection } from '@/lib/settings/store';
import { channelModes } from '@/lib/status';
import type { EmailBatchElement } from './payload';

// §7A.2 and §7A.3: sending through Resend, or through Mock on local dev and previews (D16). Webhook-driven status
// simulation, connection checks and reconciliation aren't built yet.

export class EmailProviderError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null,
    message: string,
    /** Seconds, from a 429's Retry-After. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

export type EmailProvider = {
  kind: 'resend' | 'mock';
  /** Up to 100 emails. The ids come back in request order. */
  sendBatch(emails: EmailBatchElement[], idempotencyKey: string): Promise<string[]>;
  sendOne(email: EmailBatchElement, idempotencyKey?: string): Promise<string>;
};

function toSdk({ reply_to, ...rest }: EmailBatchElement) {
  return { ...rest, ...(reply_to && { replyTo: reply_to }) };
}

type SdkResult<T> = { data: T | null; error: { name?: string; statusCode?: number | null; message?: string } | null; headers?: Record<string, string> | null };

function unwrap<T>({ data, error, headers }: SdkResult<T>): T {
  if (!error && data) return data;
  const retryAfter = Number(headers?.['retry-after']);
  throw new EmailProviderError(error?.statusCode ?? null, error?.name ?? null, error?.message ?? 'Resend returned no result', Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
}

export function createResendProvider(apiKey: string): EmailProvider {
  const resend = new Resend(apiKey);
  return {
    kind: 'resend',
    async sendBatch(emails, idempotencyKey) {
      const { data } = unwrap(await resend.batch.send(emails.map(toSdk), { idempotencyKey }));
      return data.map((email) => email.id);
    },
    async sendOne(email, idempotencyKey) {
      return unwrap(await resend.emails.send(toSdk(email), idempotencyKey ? { idempotencyKey } : undefined)).id;
    },
  };
}

const latency = () => new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 300));

/** Sends nothing. The same key returns the same ids, as Resend does. */
export function createMockProvider(): EmailProvider {
  const seen = new Map<string, string[]>();
  return {
    kind: 'mock',
    async sendBatch(emails, idempotencyKey) {
      await latency();
      const ids = seen.get(idempotencyKey) ?? emails.map(() => randomUUID());
      seen.set(idempotencyKey, ids);
      return ids;
    },
    async sendOne(email, idempotencyKey) {
      return (await this.sendBatch([email], idempotencyKey ?? randomUUID()))[0]!;
    },
  };
}

const store = globalThis as unknown as { __mockEmailProvider?: EmailProvider };

/** Null when email isn't connected. Follows the same rules as the banners, so the two can't disagree (§3.5). */
export async function getEmailProvider(db: Tx, env: Record<string, string | undefined> = process.env): Promise<EmailProvider | null> {
  const [sources, whatsapp, email] = [await credentialSources(db, env), await getSettingsSection(db, 'whatsapp'), await getSettingsSection(db, 'email')];
  const mode = channelModes({ environment: getEnvironment(env), sources, localProvider: { whatsapp: whatsapp.provider, email: email.provider } }).email;
  if (mode === 'not_connected') return null;
  if (mode === 'mock') return (store.__mockEmailProvider ??= createMockProvider());
  return createResendProvider((await getSecret(db, 'RESEND_API_KEY', env))!);
}
