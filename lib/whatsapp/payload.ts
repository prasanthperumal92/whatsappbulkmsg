// §7.4 and §5.8 step 3: template + variable mapping + contact → the /messages request body.

export type ValueSource = ({ field: string } | { attribute: string } | { static: string }) & { fallback?: string };
export type HeaderMapping = { media_id: string } | ValueSource;
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

export type PayloadContact = { wa_to: string; attributes?: Record<string, unknown> | null } & Record<string, unknown>;

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

/** G-14: Meta rejects newlines, tabs and long runs of spaces in parameters. */
const clean = (value: unknown) => (value === null || value === undefined ? '' : String(value).replace(/[\r\n\t ]+/g, ' ').trim());

function resolve(source: ValueSource | HeaderMapping | undefined, contact: PayloadContact): string | null {
  if (!source || 'media_id' in source) return null;
  const raw = 'static' in source ? source.static : 'field' in source ? contact[source.field] : contact.attributes?.[source.attribute];
  return clean(raw) || clean(source.fallback) || null;
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
    if (!header || !('media_id' in header) || !header.media_id) return skip;
    const key = format.toLowerCase();
    components.push({ type: 'header', parameters: [{ type: key, [key]: { id: header.media_id } }] });
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
