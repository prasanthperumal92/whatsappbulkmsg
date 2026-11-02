import { describe, expect, it } from 'vitest';
import golden from '../../evals/golden/template-validation.json';
import { normaliseButtonOrder, TEMPLATE_ISSUE_MESSAGES, validateTemplate, type TemplateButton, type TemplateDraft } from '@/lib/templates/validate';

const sorted = (codes: string[]) => [...codes].sort();
const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  name: 'offer',
  parameter_format: 'NAMED',
  body: 'Hi {{first_name}}, our offer is live.',
  samples: { first_name: 'Asha' },
  footer: 'Reply STOP to unsubscribe',
  buttons: [],
  ...over,
});

describe('T4.1 template validator', () => {
  type Case = { id: string; note: string; draft: unknown; expect: { errors: string[]; warnings: string[]; normalized_button_order?: string[] } };

  it.each(golden.cases as Case[])('$id $note', ({ draft: input, expect: want }) => {
    const result = validateTemplate(input as TemplateDraft);
    expect(sorted(result.errors)).toEqual(sorted(want.errors));
    expect(sorted(result.warnings)).toEqual(sorted(want.warnings));
    if (want.normalized_button_order) expect(result.buttons.map((b) => b.type)).toEqual(want.normalized_button_order);
  });

  it('FR-TPL-02 an invalid name is blocked', () => {
    const result = validateTemplate(draft({ name: 'Festive Offer!' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('E_NAME');
  });

  it('has a message for every golden code, and no others', () => {
    expect(sorted(Object.keys(TEMPLATE_ISSUE_MESSAGES))).toEqual(sorted([...golden.codes.errors, ...golden.codes.warnings]));
  });

  it('warnings alone leave a template valid', () => {
    const result = validateTemplate(draft({ footer: null }));
    expect(result.warnings).toEqual(['W_NO_OPT_OUT']);
    expect(result.valid).toBe(true);
  });

  it('name boundaries: 512 is allowed, empty is not', () => {
    expect(validateTemplate(draft({ name: 'a'.repeat(512) })).errors).toEqual([]);
    expect(validateTemplate(draft({ name: '' })).errors).toEqual(['E_NAME']);
  });

  it('counts an emoji as one character', () => {
    const body = `Hi there ${'😀'.repeat(1015)}`;
    expect(validateTemplate(draft({ body, samples: {} })).errors).toEqual([]);
  });

  it('a whitespace-only body is empty, and one error is enough', () => {
    expect(validateTemplate(draft({ body: '  \n ', samples: {} })).errors).toEqual(['E_BODY_EMPTY']);
  });

  it('positional numbering follows the order of first appearance, and repeats are allowed', () => {
    const positional = { parameter_format: 'POSITIONAL' as const, samples: { 1: 'a', 2: 'b' } };
    expect(validateTemplate(draft({ ...positional, body: 'Hi {{2}} and {{1}} today.' })).errors).toEqual(['E_POSITIONAL_SEQUENCE']);
    expect(validateTemplate(draft({ ...positional, body: 'Hi {{1}}, then {{2}}, and {{1}} again.' })).errors).toEqual([]);
  });

  it('the wrong variable style for the template is an error', () => {
    expect(validateTemplate(draft({ body: 'Hi {{1}}, welcome.', samples: { 1: 'a' } })).errors).toEqual(['E_NAMED_FORMAT']);
    expect(validateTemplate(draft({ parameter_format: 'POSITIONAL', body: 'Hi {{name}}, welcome.', samples: { name: 'a' } })).errors).toEqual(['E_POSITIONAL_SEQUENCE']);
  });

  it('a header variable needs a sample and the right format', () => {
    const header = { format: 'TEXT' as const, text: 'For {{city}}' };
    expect(validateTemplate(draft({ header })).errors).toEqual(['E_MISSING_SAMPLE']);
    expect(validateTemplate(draft({ header: { format: 'TEXT', text: 'For {{City}}' }, samples: { first_name: 'A', City: 'B' } })).errors).toEqual(['E_NAMED_FORMAT']);
    expect(validateTemplate(draft({ header, samples: { first_name: 'A', city: 'Pune' } })).errors).toEqual([]);
  });

  it('an empty sample counts as missing', () => {
    expect(validateTemplate(draft({ samples: { first_name: '  ' } })).errors).toEqual(['E_MISSING_SAMPLE']);
  });

  it('URL buttons: a suffix needs an example, and the URL must be http(s) with only {{1}} at the end', () => {
    const url = (u: string, example?: string) => draft({ buttons: [{ type: 'URL', text: 'View', url: u, example }] });
    expect(validateTemplate(url('https://example.com/{{1}}')).errors).toEqual(['E_MISSING_SAMPLE']);
    expect(validateTemplate(url('https://example.com/{{1}}', 'https://example.com/a')).errors).toEqual([]);
    expect(validateTemplate(url('https://example.com/{{1}}{{1}}', 'x')).errors).toEqual(['E_BUTTON_URL']);
    expect(validateTemplate(url('https://example.com/{{name}}', 'x')).errors).toEqual(['E_BUTTON_URL']);
    expect(validateTemplate(url('ftp://example.com')).errors).toEqual(['E_BUTTON_URL']);
    expect(validateTemplate(url('not a url')).errors).toEqual(['E_BUTTON_URL']);
  });

  it('URL shortener: matches the host and its subdomains, not a lookalike', () => {
    const warns = (u: string) => validateTemplate(draft({ buttons: [{ type: 'URL', text: 'View', url: u }] })).warnings;
    expect(warns('https://www.bit.ly/x')).toEqual(['W_URL_SHORTENER']);
    expect(warns('https://habit.ly/x')).toEqual([]);
    expect(warns('https://example.com/bit.ly')).toEqual([]);
  });

  it('G-12 density: at least two variables and under 2 words per variable', () => {
    const warns = (body: string, samples: Record<string, string>) => validateTemplate(draft({ body, samples })).warnings;
    expect(warns('Hi {{a}} and {{b}} ok.', { a: '1', b: '2' })).toEqual(['W_VARIABLE_DENSITY']); // 3 words, 2 variables
    expect(warns('Hi {{a}} and {{b}} ok then.', { a: '1', b: '2' })).toEqual([]); // 4 words, 2 variables
  });

  it('opt-out wording must be a whole word', () => {
    const footer = (text: string) => validateTemplate(draft({ footer: text })).warnings;
    expect(footer('Non-stop deals')).toEqual([]); // "stop" is a whole word here, so this stays allowed
    expect(footer('Unstoppable deals')).toEqual(['W_NO_OPT_OUT']);
    expect(footer('Opt-out any time')).toEqual([]);
  });

  describe('button grouping', () => {
    const qr = (text: string) => ({ type: 'QUICK_REPLY' as const, text });
    const link = (text: string) => ({ type: 'URL' as const, text, url: 'https://example.com' });
    const texts = (b: TemplateButton[]) => b.map((x) => ('text' in x ? x.text : null));

    it('keeps quick replies first when a quick reply comes first', () => {
      expect(texts(normaliseButtonOrder([qr('a'), link('u'), qr('b')]))).toEqual(['a', 'b', 'u']);
    });
    it('keeps quick replies last otherwise, in their original order', () => {
      expect(texts(normaliseButtonOrder([link('u'), qr('a'), link('v'), qr('b')]))).toEqual(['u', 'v', 'a', 'b']);
    });
    it('does not change its input', () => {
      const input = [qr('a'), link('u'), qr('b')];
      normaliseButtonOrder(input);
      expect(texts(input)).toEqual(['a', 'u', 'b']);
    });
  });
});
