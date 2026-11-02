// §7A.4: one element of the /emails/batch array. Always one recipient, and always the one-click unsubscribe headers.

import { resolveValue, type ValueSource, type VariableContact } from '@/lib/campaigns/variables';
import { normaliseEmail } from '@/lib/contacts/email';
import { renderHtml, renderText, type EmailBlock, type EmailFooter, type Fill } from './render';
import { signTestToken, signToken } from './unsubscribe';

export type EmailTemplate = { name: string; subject: string; preheader?: string | null; blocks: EmailBlock[] };

export type EmailSettings = {
  from: string;
  reply_to?: string | null;
  postal_address: string;
  app_url: string;
  /** Defaults to the display name in `from`. */
  business_name?: string | null;
  privacy_url?: string | null;
};

export type EmailBatchElement = {
  from: string;
  to: [string];
  reply_to?: string;
  subject: string;
  html: string;
  text: string;
  headers: { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  tags?: { name: string; value: string }[];
};

export type EmailPayloadResult = { element: EmailBatchElement } | { skip_reason: 'EMPTY_VARIABLE' | 'NO_EMAIL' };

export type EmailPayloadInput = {
  template: EmailTemplate;
  mapping: Record<string, ValueSource>;
  contact: { email?: string | null } & VariableContact;
  settings: EmailSettings;
  secret: string;
} & ({ test_send?: false; message_id: string; campaign_id?: string } | { test_send: true; test_random?: string });

const VARIABLE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function templateStrings({ subject, preheader, blocks }: EmailTemplate): string[] {
  const fromBlock = (block: EmailBlock): (string | undefined)[] => {
    switch (block.type) {
      case 'heading':
      case 'text':
        return [block.text];
      case 'image':
        return [block.alt, block.link];
      case 'button':
        return [block.label, block.url];
      default:
        return [];
    }
  };
  return [subject, preheader, ...blocks.flatMap(fromBlock)].filter((s): s is string => Boolean(s));
}

const displayName = (from: string) => from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? from;

export async function buildEmailElement(input: EmailPayloadInput): Promise<EmailPayloadResult> {
  const { template, mapping, contact, settings, secret } = input;

  const { email } = normaliseEmail(contact.email);
  if (!email) return { skip_reason: 'NO_EMAIL' };

  const values = new Map<string, string>();
  for (const text of templateStrings(template)) {
    for (const [, name] of text.matchAll(VARIABLE)) {
      const value = resolveValue(mapping[name!], contact);
      if (!value) return { skip_reason: 'EMPTY_VARIABLE' };
      values.set(name!, value);
    }
  }

  const fill: Fill = (text, url = false) =>
    text.replace(VARIABLE, (_, name: string) => {
      const value = values.get(name)!;
      return url ? encodeURIComponent(value) : value;
    });

  const token = input.test_send ? signTestToken(secret, input.test_random) : signToken(input.message_id, secret);
  const unsubscribeUrl = `${settings.app_url.replace(/\/+$/, '')}/u/${token}`;
  const footer: EmailFooter = {
    businessName: settings.business_name || displayName(settings.from),
    postalAddress: settings.postal_address,
    unsubscribeUrl,
    privacyUrl: settings.privacy_url,
  };

  const tags = input.test_send
    ? []
    : [...(input.campaign_id ? [{ name: 'campaign_id', value: input.campaign_id }] : []), { name: 'message_id', value: input.message_id }];

  return {
    element: {
      from: settings.from,
      to: [email],
      ...(settings.reply_to && { reply_to: settings.reply_to }),
      subject: `${input.test_send ? '[TEST] ' : ''}${fill(template.subject)}`,
      html: await renderHtml({ blocks: template.blocks, preheader: template.preheader, footer, fill }),
      text: renderText({ blocks: template.blocks, footer, fill }),
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      ...(tags.length > 0 && { tags }),
    },
  };
}
