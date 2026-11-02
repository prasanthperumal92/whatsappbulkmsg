// §5.7 live validation. Pure, so the designer and the server run the same rules.
// The codes are the vocabulary of evals/golden/template-validation.json, and this is the one place they're defined.

export const TEMPLATE_ISSUE_MESSAGES = {
  E_BODY_EMPTY: 'The body is empty.',
  E_LENGTH_BODY: 'The body is over 1024 characters.',
  E_LENGTH_HEADER: 'The header is over 60 characters.',
  E_LENGTH_FOOTER: 'The footer is over 60 characters.',
  E_LENGTH_BUTTON: 'A button label is over 25 characters.',
  E_NAME: 'The name must be 1–512 lowercase letters, digits or underscores.',
  E_MISSING_SAMPLE: 'Every variable needs a sample value.',
  E_POSITIONAL_SEQUENCE: 'Positional variables must run in order from {{1}}.',
  E_NAMED_FORMAT: 'Named variables must start with a lowercase letter and use only lowercase letters, digits and underscores.',
  E_VARIABLE_AT_EDGE: "The body can't start or end with a variable.",
  E_FOOTER_VARIABLE: "The footer can't contain variables.",
  E_HEADER_VARIABLES: 'The header can have at most one variable.',
  E_BUTTON_LIMIT: 'Use at most 10 buttons, with at most one call button and one copy-code button.',
  E_BUTTON_URL: 'A button URL must be http or https, with at most one {{1}}, at the end.',
  W_ADJACENT_VARIABLES: 'Two variables are next to each other.',
  W_NO_OPT_OUT: 'Add opt-out wording or a "Stop promotions" quick reply.',
  W_URL_SHORTENER: 'A URL shortener in a button is often rejected.',
  W_VARIABLE_DENSITY: 'There are too many variables for the amount of text.',
} as const;

export type TemplateIssue = keyof typeof TEMPLATE_ISSUE_MESSAGES;

export type TemplateButton =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }
  | { type: 'COPY_CODE'; example: string };

export type TemplateHeader = { format: 'TEXT'; text: string } | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT' };

export type TemplateDraft = {
  name: string;
  parameter_format: 'NAMED' | 'POSITIONAL';
  body: string;
  samples: Record<string, string>;
  header?: TemplateHeader | null;
  footer?: string | null;
  buttons?: TemplateButton[];
};

export type TemplateValidation = {
  valid: boolean;
  errors: TemplateIssue[];
  warnings: TemplateIssue[];
  /** The buttons in the order to save. Ungrouped quick replies are regrouped, not rejected (TV-24). */
  buttons: TemplateButton[];
};

const MAX_BODY = 1024;
const MAX_HEADER = 60;
const MAX_FOOTER = 60;
const MAX_BUTTON_TEXT = 25;
const MAX_BUTTONS = 10;
const MAX_NAME = 512;

/** SPEC GAP G-12: "too many variables" means two or more variables with under 2 words of text per variable. */
const MIN_WORDS_PER_VARIABLE = 2;

const NAME = /^[a-z0-9_]+$/;
const NAMED_VARIABLE = /^[a-z][a-z0-9_]*$/;
const POSITIONAL_VARIABLE = /^[1-9][0-9]*$/;
const VARIABLE = /\{\{(.*?)\}\}/g;
const OPT_OUT_WORDING = /\b(stop|unsubscribe|opt[- ]?out)\b/i;
const URL_SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'tiny.cc', 'rb.gy'];

/** In characters as people count them, so an emoji is one. */
const length = (text: string) => [...text].length;
const variablesIn = (text: string) => [...text.matchAll(VARIABLE)].map((m) => m[1]!);

function isSequential(variables: string[]) {
  const firstSeen = [...new Set(variables)];
  return firstSeen.every((v, i) => v === String(i + 1));
}

function urlHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isValidButtonUrl(url: string) {
  const variables = variablesIn(url);
  if (variables.length > 1 || (variables.length === 1 && (variables[0] !== '1' || !url.endsWith('{{1}}')))) return false;
  return urlHost(url.replace('{{1}}', 'x')) !== null;
}

const isShortener = (host: string) => URL_SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`));

/** Meta needs quick replies together, at one end: they stay first if one came first, and otherwise go last. */
export function normaliseButtonOrder(buttons: TemplateButton[]): TemplateButton[] {
  const replies = buttons.filter((b) => b.type === 'QUICK_REPLY');
  const others = buttons.filter((b) => b.type !== 'QUICK_REPLY');
  return buttons[0]?.type === 'QUICK_REPLY' ? [...replies, ...others] : [...others, ...replies];
}

export function validateTemplate(draft: TemplateDraft): TemplateValidation {
  const errors = new Set<TemplateIssue>();
  const warnings = new Set<TemplateIssue>();
  const buttons = draft.buttons ?? [];
  const footer = draft.footer ?? '';
  const header = draft.header?.format === 'TEXT' ? draft.header.text : '';
  const body = draft.body.trim();

  if (!NAME.test(draft.name) || length(draft.name) > MAX_NAME) errors.add('E_NAME');

  if (!body) errors.add('E_BODY_EMPTY');
  if (length(draft.body) > MAX_BODY) errors.add('E_LENGTH_BODY');
  if (length(header) > MAX_HEADER) errors.add('E_LENGTH_HEADER');
  if (length(footer) > MAX_FOOTER) errors.add('E_LENGTH_FOOTER');
  if (variablesIn(footer).length > 0) errors.add('E_FOOTER_VARIABLE');

  const bodyVariables = variablesIn(body);
  const headerVariables = variablesIn(header);
  if (headerVariables.length > 1) errors.add('E_HEADER_VARIABLES');

  for (const variables of [bodyVariables, headerVariables]) {
    if (draft.parameter_format === 'NAMED') {
      if (!variables.every((v) => NAMED_VARIABLE.test(v))) errors.add('E_NAMED_FORMAT');
    } else if (!variables.every((v) => POSITIONAL_VARIABLE.test(v)) || !isSequential(variables)) {
      errors.add('E_POSITIONAL_SEQUENCE');
    }
  }
  if ([...bodyVariables, ...headerVariables].some((v) => !draft.samples[v]?.trim())) errors.add('E_MISSING_SAMPLE');

  if (/^\{\{.*?\}\}/.test(body) || /\{\{[^{}]*\}\}$/.test(body)) errors.add('E_VARIABLE_AT_EDGE');
  if (/\}\}\s*\{\{/.test(body)) warnings.add('W_ADJACENT_VARIABLES');

  if (bodyVariables.length >= 2) {
    const words = body.replace(VARIABLE, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    if (words / bodyVariables.length < MIN_WORDS_PER_VARIABLE) warnings.add('W_VARIABLE_DENSITY');
  }

  const count = (type: TemplateButton['type']) => buttons.filter((b) => b.type === type).length;
  if (buttons.length > MAX_BUTTONS || count('PHONE_NUMBER') > 1 || count('COPY_CODE') > 1) errors.add('E_BUTTON_LIMIT');

  for (const button of buttons) {
    if ('text' in button && length(button.text) > MAX_BUTTON_TEXT) errors.add('E_LENGTH_BUTTON');
    if (button.type !== 'URL') continue;
    if (!isValidButtonUrl(button.url)) {
      errors.add('E_BUTTON_URL');
      continue;
    }
    if (button.url.includes('{{1}}') && !button.example?.trim()) errors.add('E_MISSING_SAMPLE');
    const host = urlHost(button.url.replace('{{1}}', 'x'));
    if (host && isShortener(host)) warnings.add('W_URL_SHORTENER');
  }

  const hasStopButton = buttons.some((b) => b.type === 'QUICK_REPLY' && /\bstop\b/i.test(b.text));
  if (!hasStopButton && !OPT_OUT_WORDING.test(`${draft.body}\n${footer}`)) warnings.add('W_NO_OPT_OUT');

  return { valid: errors.size === 0, errors: [...errors], warnings: [...warnings], buttons: normaliseButtonOrder(buttons) };
}
