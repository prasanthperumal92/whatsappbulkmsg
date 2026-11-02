import { describe, expect, it } from 'vitest';
import payloadGolden from '../../evals/golden/email-send-payload.json';
import tokenGolden from '../../evals/golden/unsubscribe-token.json';
import { buildEmailElement, type EmailBatchElement, type EmailPayloadInput, type EmailTemplate } from '@/lib/email/payload';
import { parseInline, type EmailBlock } from '@/lib/email/render';
import { signTestToken, signToken, verifyToken } from '@/lib/email/unsubscribe';

const SECRET = tokenGolden.secret;
const PREVIOUS = tokenGolden.previous_secrets;
const settings = payloadGolden.settings;

describe('T8.2 unsubscribe tokens (EM-28)', () => {
  type Case = { id: string; note: string; token: string; expect: { valid: boolean; message_id?: string; is_test?: boolean } };
  it.each(tokenGolden.cases as Case[])('$id $note', ({ token, expect: want }) => {
    const result = verifyToken(token, SECRET, PREVIOUS);
    expect(result.valid).toBe(want.valid);
    if (want.message_id) expect(result).toMatchObject({ message_id: want.message_id, is_test: false });
    if (want.is_test) {
      expect(result).toMatchObject({ is_test: true });
      expect(result).not.toHaveProperty('message_id'); // Nothing for the route to write against.
    }
  });

  it('signs the golden token exactly', () => {
    const uuid = '0192f4e0-0000-7000-8000-000000000042';
    expect(signToken(uuid, SECRET)).toBe(tokenGolden.cases[0]!.token);
    expect(signToken(uuid, PREVIOUS[0]!)).toBe(tokenGolden.cases[5]!.token);
  });
  it('a previous secret stops working if it is not configured', () => {
    expect(verifyToken(tokenGolden.cases[5]!.token, SECRET).valid).toBe(false);
  });
  it('a test token verifies as a test, with a random value each time', () => {
    const a = signTestToken(SECRET);
    expect(verifyToken(a, SECRET)).toEqual({ valid: true, is_test: true });
    expect(signTestToken(SECRET)).not.toBe(a);
  });
  it.each(['', '.', 'a.', '.a', 'a.b.c', 'é.é', `${tokenGolden.cases[0]!.token}=`, `${tokenGolden.cases[0]!.token}.x`])('refuses %j without throwing', (token) => {
    expect(verifyToken(token, SECRET)).toEqual({ valid: false });
  });
  it('refuses a padded or re-spelled signature', () => {
    const [value, signature] = tokenGolden.cases[0]!.token.split('.');
    const last = signature!.at(-1)!;
    const respelled = `${value}.${signature!.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    expect(verifyToken(respelled, SECRET).valid).toBe(false);
  });
});

describe('T8.2 email payload (EM-08)', () => {
  type Expect = {
    from?: string; to?: string[]; reply_to?: string; subject?: string; headers?: Record<string, string>; tags?: unknown;
    html_contains?: string[]; html_not_contains?: string[]; text_contains?: string[]; no_keys?: string[]; skip_reason?: string;
    render_twice_identical?: boolean; headers_present?: string[]; tags_absent?: string[];
  };
  type Case = { id: string; note: string; test_send?: boolean; template: unknown; mapping: unknown; contact: unknown; message_id?: string; campaign_id?: string; expect: Expect };

  const inputFor = (c: Case): EmailPayloadInput => {
    const shared = { template: c.template as EmailTemplate, mapping: c.mapping as EmailPayloadInput['mapping'], contact: c.contact as EmailPayloadInput['contact'], settings, secret: SECRET };
    return c.test_send ? { ...shared, test_send: true, test_random: 'fixed' } : { ...shared, message_id: c.message_id!, campaign_id: c.campaign_id };
  };

  it.each(payloadGolden.cases as Case[])('$id $note', async (c) => {
    const result = await buildEmailElement(inputFor(c));
    const want = c.expect;
    if (want.skip_reason) return expect(result).toEqual({ skip_reason: want.skip_reason });
    if (!('element' in result)) throw new Error(`skipped: ${result.skip_reason}`);
    const el = result.element;
    const token = c.message_id ? signToken(c.message_id, SECRET) : '';
    const sub = (s: string) => s.replace('{token(message_id)}', token);

    if (want.from) expect(el.from).toBe(want.from);
    if (want.to) expect(el.to).toEqual(want.to);
    if (want.reply_to) expect(el.reply_to).toBe(want.reply_to);
    if (want.subject) expect(el.subject).toBe(want.subject);
    if (want.tags) expect(el.tags).toEqual(want.tags);
    if (want.headers) expect(el.headers).toEqual(Object.fromEntries(Object.entries(want.headers).map(([k, v]) => [k, sub(v)])));
    for (const s of want.html_contains ?? []) expect(el.html).toContain(sub(s));
    for (const s of want.html_not_contains ?? []) expect(el.html).not.toContain(s);
    for (const s of want.text_contains ?? []) expect(el.text).toContain(sub(s));
    for (const k of want.no_keys ?? []) expect(el).not.toHaveProperty(k);
    for (const h of want.headers_present ?? []) expect(el.headers).toHaveProperty(h);
    for (const t of want.tags_absent ?? []) expect((el.tags ?? []).map((x) => x.name)).not.toContain(t);
    if (want.render_twice_identical) expect(await buildEmailElement(inputFor(c))).toEqual(result);
  });

  const build = async (blocks: EmailBlock[], over: Partial<EmailPayloadInput> = {}): Promise<EmailBatchElement> => {
    const result = await buildEmailElement({
      template: { name: 't', subject: 'Hello', blocks },
      mapping: { name: { field: 'first_name' }, code: { attribute: 'code' } },
      contact: { email: 'a@example.com', first_name: 'Asha', attributes: { code: 'X Y' } },
      settings,
      secret: SECRET,
      message_id: 'm-1',
      ...over,
    } as EmailPayloadInput);
    if (!('element' in result)) throw new Error('skipped');
    return result.element;
  };

  it('§7A.4 the text part has the documented shape', async () => {
    const el = await build([{ type: 'text', text: 'Hi {{name}}.' }, { type: 'button', label: 'View', url: 'https://e.com/{{code}}' }]);
    const url = `https://wa.example.com/u/${signToken('m-1', SECRET)}`;
    expect(el.text).toBe(`Hi Asha.\n\nView: https://e.com/X%20Y\n\n—\nExample Exports, 12 Harbour Road, Kochi 682001, India\nUnsubscribe: ${url}`);
  });

  it('FR-EML-04 the footer and headers are there with no blocks at all', async () => {
    const el = await build([]);
    expect(el.html).toContain('12 Harbour Road, Kochi 682001, India');
    expect(el.html).toContain('>Unsubscribe<');
    expect(el.text).toContain('Unsubscribe: https://wa.example.com/u/');
    expect(Object.keys(el.headers)).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
  });

  it('adds the privacy link only when one is set', async () => {
    const privacy = { ...settings, privacy_url: 'https://e.com/privacy' };
    const el = await build([], { settings: privacy });
    expect(el.html).toContain('href="https://e.com/privacy"');
    expect(el.text).toContain('Privacy notice: https://e.com/privacy');
    expect((await build([])).html).not.toContain('Privacy notice');
  });

  it('prefers the configured business name, and a trailing slash in the app URL is harmless', async () => {
    const el = await build([], { settings: { ...settings, business_name: 'Grace Ferro', app_url: 'https://wa.example.com/' } });
    expect(el.text).toContain('Grace Ferro, 12 Harbour');
    expect(el.text).toContain('https://wa.example.com/u/');
    expect(el.text).not.toContain('com//u');
  });

  it('renders every block type, and limits the width', async () => {
    const el = await build([
      { type: 'heading', text: 'Sale for {{name}}' },
      { type: 'image', src: 'https://cdn.example.com/a.png', alt: 'Banner', link: 'https://e.com/{{code}}' },
      { type: 'divider' },
      { type: 'spacer', height: 40 },
    ]);
    expect(el.html).toContain('Sale for Asha');
    expect(el.html).toContain('src="https://cdn.example.com/a.png"');
    expect(el.html).toContain('alt="Banner"');
    expect(el.html).toContain('href="https://e.com/X%20Y"');
    expect(el.html).toContain('height:40px');
    expect(el.html).toContain('max-width:600px');
    expect(el.text).toContain('Banner: https://e.com/X%20Y');
  });

  it('text marks render, and values cannot add marks or links', async () => {
    const el = await build(
      [{ type: 'text', text: 'Hi *{{name}}*, _today_ see [our offer](https://e.com/{{code}}).' }],
      { contact: { email: 'a@example.com', first_name: '*x* [y](https://evil.example)', attributes: { code: 'A' } } },
    );
    expect(el.html).toContain('<strong>*x* [y](https://evil.example)</strong>');
    expect(el.html).toContain('<em>today</em>');
    expect(el.html).toContain('href="https://e.com/A"');
    expect(el.html).not.toContain('href="https://evil.example"');
    expect(el.text).toContain('Hi *x* [y](https://evil.example), today see our offer (https://e.com/A).');
  });

  it('underscores in variables and words are not italics', () => {
    expect(parseInline('{{first_name}} and {{last_name}}, snake_case_word')).toEqual([{ kind: 'plain', text: '{{first_name}} and {{last_name}}, snake_case_word' }]);
    expect(parseInline('_a_ b')).toEqual([{ kind: 'italic', text: 'a' }, { kind: 'plain', text: ' b' }]);
  });

  it('escapes a value in an attribute and has no comment markers splitting the text', async () => {
    const el = await build([{ type: 'text', text: 'Hi {{name}}, welcome.' }, { type: 'image', src: 'https://c.example/a.png', alt: '{{name}}' }], {
      contact: { email: 'a@example.com', first_name: '"><script>x</script>', attributes: {} },
    });
    expect(el.html).not.toContain('<script>x');
    expect(el.html).not.toContain('Hi <!-- -->');
    expect(el.text).toContain('Hi "><script>x</script>, welcome.');
  });

  it('a variable with no mapping skips the recipient, and so does an invalid address', async () => {
    const skip = (subject: string, email: string) => buildEmailElement({ template: { name: 't', subject, blocks: [] }, mapping: {}, contact: { email }, settings, secret: SECRET, message_id: 'm' });
    expect(await skip('Hi {{who}}', 'a@example.com')).toEqual({ skip_reason: 'EMPTY_VARIABLE' });
    expect(await skip('Hi', 'not-an-email')).toEqual({ skip_reason: 'NO_EMAIL' });
  });

  it('a test send is signed over test:{random}, and carries no tags', async () => {
    const el = await build([], { test_send: true, test_random: 'r1' } as Partial<EmailPayloadInput>);
    const token = el.headers['List-Unsubscribe'].match(/\/u\/([^>]+)>/)![1]!;
    expect(verifyToken(token, SECRET)).toEqual({ valid: true, is_test: true });
    expect(el).not.toHaveProperty('tags');
    expect(el.subject).toBe('[TEST] Hello');
  });

  it('tag values use only the characters Resend allows', async () => {
    const el = await build([], { message_id: '0192f4e0-0000-7000-8000-000000000042', campaign_id: '0192f4d1-0000-7000-8000-000000000001' } as Partial<EmailPayloadInput>);
    for (const tag of el.tags!) expect(`${tag.name}${tag.value}`).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
