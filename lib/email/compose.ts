import { z } from 'zod';
import type { ValueSource } from '@/lib/campaigns/variables';
import { ApiError } from '@/lib/api/errors';
import { COMPOSE_VARIABLES } from './shared';
import { templateStrings, VARIABLE, type EmailTemplate } from './payload';
import type { EmailBlock } from './render';

// An email written straight into the send form on S-03. It becomes an ordinary template, so it goes through the same
// renderer and footer as S-11's will.

export const composition = z.object({
  // One line: a line break in a subject would be a header injection.
  subject: z.string().trim().min(1, 'Enter a subject').max(200).regex(/^[^\r\n]*$/, 'The subject must be one line'),
  body: z.string().trim().min(1, 'Write a message').max(20_000),
});
export type Composition = z.output<typeof composition>;

/** A missing first name reads naturally as "there". The others have no sensible stand-in, so those contacts are skipped. */
export const COMPOSE_MAPPING: Record<string, ValueSource> = {
  first_name: { field: 'first_name', fallback: 'there' },
  last_name: { field: 'last_name' },
  company: { field: 'company' },
  city: { field: 'city' },
};

export function toTemplate({ subject, body }: Composition): EmailTemplate {
  const blocks: EmailBlock[] = body
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ type: 'text', text }));
  const template = { name: 'direct_send', subject, blocks };
  // Refused up front: an unknown variable would otherwise skip every recipient.
  for (const text of templateStrings(template)) {
    for (const [, name] of text.matchAll(VARIABLE)) {
      if (!COMPOSE_MAPPING[name!]) throw new ApiError(400, 'unknown_variable', `{{${name}}} isn't available. Use ${COMPOSE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.`);
    }
  }
  return template;
}

export const fromHeader = (name: string, address: string) => `"${name.replace(/["\\\r\n]/g, '').trim()}" <${address}>`;
