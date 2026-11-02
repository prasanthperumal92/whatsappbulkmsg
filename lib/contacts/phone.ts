import { isValidPhoneNumber, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

// §4.5. One function shared by browser and server. The goldens depend on the library's metadata, so its
// version is pinned exactly in package.json: re-run PN-* before changing it.

export type PhoneRejectReason = 'INVALID_PHONE' | 'SCIENTIFIC_NOTATION' | 'EMPTY_PHONE';
export type PhoneResult = { phone_e164: string; wa_to: string } | { reject: PhoneRejectReason };
export type PhoneOptions = { countryCode?: string | null; defaultCountry?: string | null };

const SCIENTIFIC = /^[+-]?\d+(?:[.,]\d+)?[eE][+-]?\d+$/;
// All Unicode spaces and format characters (G-02), plus the separators §4.5 strips.
const SEPARATORS = /[\p{Zs}\p{Cf}\s\-.()]/gu;

export function normalisePhone(raw: string | null | undefined, options: PhoneOptions = {}): PhoneResult {
  const text = (raw ?? '').replace(/^[\p{Zs}\p{Cf}\s]+|[\p{Zs}\p{Cf}\s]+$/gu, '');
  if (!text) return { reject: 'EMPTY_PHONE' };
  if (SCIENTIFIC.test(text)) return { reject: 'SCIENTIFIC_NOTATION' };

  let value = text.replace(SEPARATORS, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;

  const dial = (options.countryCode ?? '').replace(/\D/g, '');
  if (dial && !value.startsWith('+')) value = `+${dial}${value.replace(/^0+/, '')}`;

  const country = (options.defaultCountry || 'IN') as CountryCode;
  const parsed = value.startsWith('+') ? parsePhoneNumberFromString(value) : parsePhoneNumberFromString(value, country);
  if (!parsed || !isValidPhoneNumber(parsed.number)) return { reject: 'INVALID_PHONE' };
  // `number` is plain E.164, so an extension is dropped here (G-04).
  return { phone_e164: parsed.number, wa_to: parsed.number.slice(1) };
}

/** The ISO country libphonenumber assigns to a number: +44 7911… is GG, not GB. */
export function phoneCountry(e164: string): string | null {
  return parsePhoneNumberFromString(e164)?.country ?? null;
}
