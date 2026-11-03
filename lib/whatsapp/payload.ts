// §7.4 and §5.8 step 3: template + variable mapping + contact → the /messages request body.

import { resolveValue, type ValueSource, type VariableContact } from '@/lib/campaigns/variables';

export type HeaderMapping = { media_id: string } | { media_link: string } | ValueSource;
/** Keys are body variable names, `header`, and `button_{index}` for a URL suffix. */
export type VariableMapping = Record<string, ValueSource | HeaderMapping>;

export type PayloadTemplate = {
  name: string;
  language: string;
  parameter_format: 'NAMED' | 'POSITIONAL';
  body_vars: string[];
  header_format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /** The variable in a text header, if it has one. */
  header_var?: string;
  url_button_index?: number;
};

export type PayloadContact = { wa_to: string } & VariableContact;

type TextParameter = { type: 'text'; parameter_name?: string; text: string };
type MediaParameter = { type: string } & Record<string, unknown>;
export type TemplateComponent =
  | { type: 'header'; parameters: (TextParameter | MediaParameter)[] }
  | { type: 'body'; parameters: TextParameter[] }
  | { type: 'button'; sub_type: 'url'; index: string; parameters: TextParameter[] };

export type SendPayload = {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'template';
  biz_opaque_callback_data: string;
  template: { name: string; language: { code: string }; components?: TemplateComponent[] };
};

export type PayloadResult = { body: SendPayload } | { skip_reason: 'EMPTY_VARIABLE' };

function resolve(source: ValueSource | HeaderMapping | undefined, contact: PayloadContact): string | null {
  return !source || 'media_id' in source || 'media_link' in source ? null : resolveValue(source, contact);
}

/** Returns the request body, or a skip reason: a recipient is never sent an empty variable. */
export function buildSendPayload(template: PayloadTemplate, mapping: VariableMapping, contact: PayloadContact, messageId: string): PayloadResult {
  const skip: PayloadResult = { skip_reason: 'EMPTY_VARIABLE' };
  const named = template.parameter_format === 'NAMED';
  const textParameter = (variable: string, text: string): TextParameter => (named ? { type: 'text', parameter_name: variable, text } : { type: 'text', text });
  const components: TemplateComponent[] = [];

  const format = template.header_format;
  if (format === 'TEXT') {
    if (template.header_var) {
      const text = resolve(mapping.header, contact);
      if (!text) return skip;
      components.push({ type: 'header', parameters: [textParameter(template.header_var, text)] });
    }
  } else if (format) {
    const header = mapping.header;
    const key = format.toLowerCase();
    if (header && 'media_link' in header && header.media_link) {
      components.push({ type: 'header', parameters: [{ type: key, [key]: { link: header.media_link } }] });
    } else if (header && 'media_id' in header && header.media_id) {
      components.push({ type: 'header', parameters: [{ type: key, [key]: { id: header.media_id } }] });
    } else {
      return skip;
    }
  }

  if (template.body_vars.length > 0) {
    const parameters: TextParameter[] = [];
    for (const variable of template.body_vars) {
      const text = resolve(mapping[variable], contact);
      if (!text) return skip;
      parameters.push(textParameter(variable, text));
    }
    components.push({ type: 'body', parameters });
  }

  if (template.url_button_index !== undefined) {
    const text = resolve(mapping[`button_${template.url_button_index}`], contact);
    if (!text) return skip;
    components.push({ type: 'button', sub_type: 'url', index: String(template.url_button_index), parameters: [{ type: 'text', text }] });
  }

  return {
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: contact.wa_to,
      type: 'template',
      biz_opaque_callback_data: messageId,
      template: { name: template.name, language: { code: template.language }, ...(components.length > 0 && { components }) },
    },
  };
}
