import { describe, expect, it } from 'vitest';
import matchGolden from '../../evals/golden/contact-matching.json';
import { matchContact, type MatchRow, type StoreContact } from '@/lib/contacts/match';
import { columnLetter, ImportLimitError, parseCsv } from '@/lib/imports/csv';
import { detectAll, detectEncoding } from '@/lib/imports/detect';
import { headerSignature, mappingProblem, suggestMapping } from '@/lib/imports/mapping';
import { mergeContact, newContact, type MergeContext } from '@/lib/imports/merge';
import { buildReader, normaliseRow, type RowOptions } from '@/lib/imports/rows';
import type { ContactRow } from '@/lib/contacts/store';

describe('T2.3 matchContact', () => {
  it.each(matchGolden.cases as { id: string; row: MatchRow; store: StoreContact[]; expect: unknown }[])('$id', ({ row, store, expect: want }) => {
    expect(matchContact(row, store)).toEqual(want);
  });
});

describe('T2.7 mapping', () => {
  it('FR-IMP-03 suggests from synonyms', () => {
    expect(suggestMapping(['Mobile No', 'Name', 'Segment', 'Notes'])).toEqual({ 0: 'phone', 1: 'first_name', 2: 'tags', 3: null });
  });
  it('ignores case, accents and punctuation', () => {
    expect(suggestMapping(['TÉLÉPHONE', 'e-mail', 'time_zone'])).toEqual({ 0: 'phone', 1: 'email', 2: 'time_zone' });
  });
  it('gives a target to the first column only, except Tags', () => {
    expect(suggestMapping(['Phone', 'Mobile', 'Segment', 'Tags'])).toEqual({ 0: 'phone', 1: null, 2: 'tags', 3: 'tags' });
  });
  it('FR-IMP-04 needs Phone or Email', () => {
    expect(mappingProblem({ 0: 'first_name' })).toMatch(/Phone or Email/);
    expect(mappingProblem({ 0: 'email' })).toBeNull();
    expect(mappingProblem({ 0: 'phone', 1: 'phone' })).toMatch(/only one column/);
    expect(mappingProblem({ 0: 'phone', 1: 'tags', 2: 'tags' })).toBeNull();
  });
  it('FR-IMP-09 signature ignores case and punctuation but not order', () => {
    expect(headerSignature(['Mobile No', 'Name'])).toBe(headerSignature(['mobile_no', 'NAME']));
    expect(headerSignature(['Name', 'Mobile No'])).not.toBe(headerSignature(['Mobile No', 'Name']));
  });
});

describe('T2.6 detection', () => {
  it('a UTF-8 character cut off at the end of a preview slice is not mistaken for Windows-1252', () => {
    const bytes = new TextEncoder().encode('phone,name\n9876543210,José');
    expect(detectEncoding(bytes.subarray(0, bytes.length - 1), { truncated: true }).encoding).toBe('utf-8');
  });
  it('finds a delimiter from what is consistent, not what is common', () => {
    expect(detectAll(new TextEncoder().encode('a;b;c\n1,5;2,5;x\n3,5;4,5;y\n')).delimiter).toBe(';');
  });
  it('names columns the way a spreadsheet does', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
  it('a short row does not lose or shift its cells', () => {
    const { rows, headers } = parseCsv('a,b,c\n1\n', { delimiter: ',', quote: '"', header_row: true, rows_to_skip: 0 });
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([['1']]);
  });
  it('SEC-11 enforces the limits in the parser', () => {
    const opts = { delimiter: ',', quote: '"', header_row: true, rows_to_skip: 0 };
    expect(() => parseCsv(`a\n${'1\n'.repeat(200_001)}`, opts)).toThrow(ImportLimitError);
    expect(() => parseCsv(`a\n${'1\n'.repeat(200_000)}`, opts)).not.toThrow();
  });
});

const options: RowOptions = { default_country: 'IN', tag_separator: ';', apply_tags: [], opt_in_value: 'unknown', email_opt_in_value: 'unknown', consent_proof_value: null };
const ctx = (extra: Partial<MergeContext> = {}): MergeContext => ({ batchId: 'b', source: 'csv:f', now: '2026-11-02T00:00:00.000Z', userId: 'u', suppressedPhones: new Set(), suppressedEmails: new Set(), ...extra });
const reader = buildReader({ 0: 'phone', 1: 'email', 2: 'first_name', 3: 'opt_in', 4: 'email_opt_in' });
const row = (...cells: string[]) => normaliseRow(cells, 0, reader, options);
const base = (extra: Partial<ContactRow> = {}) => ({ ...newContact('c1', row('9876543210', 'a@example.com', 'Asha'), ctx()), ...extra });

describe('consent never moves the wrong way (§4.4, §4.7)', () => {
  it('an opted-out contact stays opted out on every policy', () => {
    for (const policy of ['skip', 'fill_empty', 'overwrite'] as const) {
      const merged = mergeContact(base({ opt_in_status: 'opted_out' }), row('9876543210', '', '', 'yes'), undefined, policy, ctx());
      expect(merged?.opt_in_status ?? 'opted_out').toBe('opted_out');
    }
  });
  it('a file saying `no` does not lower an existing opt-in (G-15)', () => {
    const merged = mergeContact(base({ opt_in_status: 'opted_in' }), row('9876543210', '', '', 'no'), undefined, 'overwrite', ctx());
    expect(merged?.opt_in_status ?? 'opted_in').toBe('opted_in');
  });
  it('Skip does not grant consent', () => {
    const merged = mergeContact(base(), row('9876543210', '', '', 'yes'), undefined, 'skip', ctx());
    expect(merged).toBeNull();
  });
  it('an unknown contact can be opted in, with its source and time', () => {
    const merged = mergeContact(base(), row('9876543210', '', '', 'yes'), undefined, 'fill_empty', ctx());
    expect(merged).toMatchObject({ opt_in_status: 'opted_in', opt_in_source: 'csv:f', opt_in_at: '2026-11-02T00:00:00.000Z' });
  });
  it('a suppressed number is opted out even if the contact was not', () => {
    const merged = mergeContact(base({ opt_in_status: 'opted_in' }), row('9876543210'), undefined, 'skip', ctx({ suppressedPhones: new Set(['+919876543210']) }));
    expect(merged?.opt_in_status).toBe('opted_out');
  });
  it('§4.7 a changed email resets email consent, even from opted in', () => {
    const merged = mergeContact(base({ email_opt_in_status: 'opted_in' }), row('9876543210', 'new@example.com'), undefined, 'overwrite', ctx());
    expect(merged).toMatchObject({ email: 'new@example.com', email_opt_in_status: 'unknown', email_opt_in_at: null });
  });
  it('§4.7 a changed email keeps a confirmed opt-in from the same row', () => {
    const merged = mergeContact(base(), row('9876543210', 'new@example.com', '', '', 'yes'), undefined, 'overwrite', ctx());
    expect(merged).toMatchObject({ email: 'new@example.com', email_opt_in_status: 'opted_in' });
  });
  it('§4.7 a new email on the suppression list is opted out', () => {
    const merged = mergeContact(base(), row('9876543210', 'new@example.com', '', '', 'yes'), undefined, 'overwrite', ctx({ suppressedEmails: new Set(['new@example.com']) }));
    expect(merged?.email_opt_in_status).toBe('opted_out');
  });
  it('a contact with no phone can never be opted in for WhatsApp', () => {
    expect(newContact('c', row('', 'a@example.com', '', 'yes'), ctx()).opt_in_status).toBe('unknown');
  });
  it('re-importing identical data changes nothing', () => {
    expect(mergeContact(base(), row('9876543210', 'a@example.com', 'Asha'), undefined, 'overwrite', ctx())).toBeNull();
  });
});
