import type { PayloadTemplate } from './payload';

// What a template from Meta needs at send time. Pure and free of server imports, so the browser can use the types.

export type MetaComponent = { type: string; format?: string; text?: string; buttons?: { type: string; text?: string; url?: string }[] };
export type MetaTemplate = {
  id: string;
  name: string;
  status: string;
  category?: string;
  language: string;
  parameter_format?: string;
  components?: MetaComponent[];
  quality_score?: { score?: string };
  rejected_reason?: string;
};

export type VariableSlot = { key: string; label: string; kind: 'text' | 'media'; format?: string };

export type TemplateShape = {
  payload: PayloadTemplate;
  slots: VariableSlot[];
  body: string;
  header_text: string | null;
  footer: string | null;
  buttons: string[];
  /** Why this template can't be sent from the app yet. Null when it can. */
  unsupported: string | null;
};

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const MEDIA_FORMATS = ['IMAGE', 'VIDEO', 'DOCUMENT'] as const;
const PLAIN_BUTTONS = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'];

const variablesIn = (text: string) => [...new Set([...text.matchAll(VARIABLE)].map((m) => m[1]!))];

export function templateShape({ name, language, category, parameter_format, components = [] }: Pick<MetaTemplate, 'name' | 'language' | 'category' | 'parameter_format' | 'components'>): TemplateShape {
  const find = (type: string) => components.find((c) => c.type?.toUpperCase() === type);
  const header = find('HEADER');
  const bodyText = find('BODY')?.text ?? '';
  const buttons = find('BUTTONS')?.buttons ?? [];
  const headerFormat = header?.format?.toUpperCase();
  const headerVars = headerFormat === 'TEXT' ? variablesIn(header?.text ?? '') : [];
  const bodyVars = variablesIn(bodyText);
  const isPositional = [...bodyVars, ...headerVars].every((v) => /^\d+$/.test(v));
  const format = parameter_format?.toUpperCase() === 'POSITIONAL' || (!parameter_format && isPositional) ? 'POSITIONAL' : 'NAMED';

  const dynamicUrls = buttons.flatMap((b, index) => (b.type?.toUpperCase() === 'URL' && b.url && variablesIn(b.url).length > 0 ? [index] : []));
  const known = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);

  const unsupported =
    category?.toUpperCase() === 'AUTHENTICATION'
      ? 'One-time-password templates aren’t supported.'
      : components.some((c) => !known.has(c.type?.toUpperCase()))
        ? 'This template uses a component the app can’t fill in yet, such as a carousel or a limited-time offer.'
        : headerFormat && headerFormat !== 'TEXT' && !(MEDIA_FORMATS as readonly string[]).includes(headerFormat)
          ? 'This template’s header type isn’t supported.'
          : buttons.some((b) => !PLAIN_BUTTONS.includes(b.type?.toUpperCase()))
            ? 'This template has a button the app can’t fill in yet, such as a copy-code or flow button.'
            : dynamicUrls.length > 1
              ? 'This template has more than one link with a variable. The app supports one.'
              : null;

  const slots: VariableSlot[] = [
    ...(headerFormat && headerFormat !== 'TEXT' ? [{ key: 'header', label: `Header ${headerFormat.toLowerCase()} link`, kind: 'media' as const, format: headerFormat }] : []),
    ...(headerVars[0] ? [{ key: 'header', label: `Header {{${headerVars[0]}}}`, kind: 'text' as const }] : []),
    ...bodyVars.map((v) => ({ key: v, label: `{{${v}}}`, kind: 'text' as const })),
    ...(dynamicUrls[0] !== undefined ? [{ key: `button_${dynamicUrls[0]}`, label: `End of the “${buttons[dynamicUrls[0]]!.text ?? 'link'}” link`, kind: 'text' as const }] : []),
  ];

  return {
    payload: {
      name,
      language,
      parameter_format: format,
      body_vars: bodyVars,
      ...(headerFormat && { header_format: headerFormat as PayloadTemplate['header_format'] }),
      ...(headerVars[0] && { header_var: headerVars[0] }),
      ...(dynamicUrls[0] !== undefined && { url_button_index: dynamicUrls[0] }),
    },
    slots,
    body: bodyText,
    header_text: headerFormat === 'TEXT' ? (header?.text ?? null) : null,
    footer: find('FOOTER')?.text ?? null,
    buttons: buttons.flatMap((b) => (b.text ? [b.text] : [])),
    unsupported,
  };
}

/** The body as one recipient would read it. */
export function renderBody(body: string, values: (variable: string) => string | null): string {
  return body.replace(VARIABLE, (whole, name: string) => values(name) ?? whole);
}
