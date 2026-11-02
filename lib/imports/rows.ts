import { normaliseEmail } from '@/lib/contacts/email';
import { normalisePhone, phoneCountry } from '@/lib/contacts/phone';
import { parseCountry, resolveTimeZone } from '@/lib/geo';
import type { Mapping, StandardTarget } from './mapping';

// §4.5–§4.8 applied to one CSV row. Pure.

export type ConsentValue = 'opted_in' | 'unknown' | 'opted_out';

export type RowOptions = {
  default_country: string;
  tag_separator: string;
  apply_tags: string[];
  /** The whole-file value, used when no opt-in column is mapped. */
  opt_in_value: ConsentValue;
  email_opt_in_value: ConsentValue;
  consent_proof_value: string | null;
};

export type TextField = 'first_name' | 'last_name' | 'display_name' | 'company' | 'city' | 'language' | 'consent_proof_ref';
export const TEXT_FIELDS: TextField[] = ['first_name', 'last_name', 'display_name', 'company', 'city', 'language', 'consent_proof_ref'];

export type NormalisedRow = {
  index: number;
  phone: string | null;
  wa_to: string | null;
  phone_reason: 'INVALID_PHONE' | 'SCIENTIFIC_NOTATION' | 'EMPTY_PHONE' | null;
  email: string | null;
  invalid_email: boolean;
  role_email: boolean;
  fields: Partial<Record<TextField, string>>;
  tags: string[];
  attributes: Record<string, string>;
  country: string | null;
  country_mapped: boolean;
  time_zone: string | null;
  zone_mapped: boolean;
  invalid_time_zone: boolean;
  opt_in: ConsentValue;
  email_opt_in: ConsentValue;
};

const TRUTHY = new Set(['yes', 'true', '1', 'y']);
/** G-15: case-insensitive, and anything else, `no` included, is `unknown`. */
const parseConsentCell = (cell: string | undefined): ConsentValue => (TRUTHY.has((cell ?? '').trim().toLowerCase()) ? 'opted_in' : 'unknown');

export const parseTags = (cell: string | undefined, separator: string) =>
  (cell ?? '')
    .split(separator)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

/** Precomputed column lookups, because this runs once per row of a large file. */
export type RowReader = { single: Partial<Record<StandardTarget, number>>; tags: number[]; custom: [number, string][] };

export function buildReader(mapping: Mapping): RowReader {
  const reader: RowReader = { single: {}, tags: [], custom: [] };
  for (const [column, target] of Object.entries(mapping)) {
    if (!target) continue;
    if (target === 'tags') reader.tags.push(Number(column));
    else if (target.startsWith('custom:')) reader.custom.push([Number(column), target.slice(7)]);
    else reader.single[target as StandardTarget] = Number(column);
  }
  return reader;
}

export function normaliseRow(cells: string[], index: number, reader: RowReader, options: RowOptions): NormalisedRow {
  const cell = (target: StandardTarget) => {
    const column = reader.single[target];
    return column === undefined ? undefined : cells[column]?.trim();
  };

  const phone = normalisePhone(cell('phone'), { countryCode: cell('country_code'), defaultCountry: options.default_country });
  const usable = 'phone_e164' in phone ? phone : null;
  const email = normaliseEmail(cell('email'));

  const fields: NormalisedRow['fields'] = {};
  for (const [field, target] of [
    ['first_name', 'first_name'], ['last_name', 'last_name'], ['display_name', 'display_name'],
    ['company', 'company'], ['city', 'city'], ['language', 'language'], ['consent_proof_ref', 'consent_proof'],
  ] as const) {
    const value = cell(target);
    if (value) fields[field] = value;
  }
  if (!fields.consent_proof_ref && options.consent_proof_value) fields.consent_proof_ref = options.consent_proof_value;

  const tags = new Set(options.apply_tags.map((t) => t.trim().toLowerCase()).filter(Boolean));
  for (const column of reader.tags) for (const tag of parseTags(cells[column], options.tag_separator)) tags.add(tag);

  const attributes: Record<string, string> = {};
  for (const [column, name] of reader.custom) {
    const value = cells[column]?.trim();
    if (value) attributes[name] = value;
  }

  const mappedCountry = parseCountry(cell('country'));
  const country = mappedCountry ?? (usable ? phoneCountry(usable.phone_e164) : null);
  const zone = resolveTimeZone({ countryIso: country, mapped: cell('time_zone') });
  const zoneMapped = !!cell('time_zone') && !zone.warning;

  return {
    index,
    phone: usable?.phone_e164 ?? null,
    wa_to: usable?.wa_to ?? null,
    phone_reason: usable ? null : ('reject' in phone ? phone.reject : null),
    email: email.email,
    invalid_email: email.warning === 'INVALID_EMAIL',
    role_email: !!email.role,
    fields,
    tags: [...tags],
    attributes,
    country,
    country_mapped: !!mappedCountry,
    time_zone: zone.timeZone,
    zone_mapped: zoneMapped,
    invalid_time_zone: zone.warning === 'INVALID_TIME_ZONE',
    opt_in: reader.single.opt_in === undefined ? options.opt_in_value : parseConsentCell(cell('opt_in')),
    email_opt_in: reader.single.email_opt_in === undefined ? options.email_opt_in_value : parseConsentCell(cell('email_opt_in')),
  };
}
