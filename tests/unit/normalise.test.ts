import { describe, expect, it } from 'vitest';
import { getCountries } from 'libphonenumber-js/max';
import emailGolden from '../../evals/golden/email-normalisation.json';
import phoneGolden from '../../evals/golden/phone-normalisation.json';
import zoneGolden from '../../evals/golden/recipient-time-zone.json';
import { normaliseEmail } from '@/lib/contacts/email';
import { normalisePhone, phoneCountry } from '@/lib/contacts/phone';
import { countryZone, isValidTimeZone, parseCountry, resolveTimeZone } from '@/lib/geo';
import { COUNTRY_ZONES } from '@/lib/geo/zones';

describe('T2.1 phone normalisation', () => {
  type Case = { id: string; raw: string; country_code?: string; default_country?: string; expect: unknown };
  it.each(phoneGolden.cases as Case[])('$id $raw', ({ raw, country_code, default_country, expect: want }) => {
    expect(normalisePhone(raw, { countryCode: country_code, defaultCountry: default_country })).toEqual(want);
  });

  it('FR-IMP-05', () => expect(normalisePhone('098765 43210')).toEqual({ phone_e164: '+919876543210', wa_to: '919876543210' }));
  it('finds the country libphonenumber assigns', () => {
    expect(phoneCountry('+447911123456')).toBe('GG');
    expect(phoneCountry('+447400123456')).toBe('GB');
  });
});

describe('T2.2 email normalisation', () => {
  it.each(emailGolden.cases)('$id $raw', ({ raw, expect: want }) => {
    expect(normaliseEmail(raw)).toEqual(want);
  });
});

describe('T2.12 country and time zone', () => {
  it.each(zoneGolden.cases as { id: string; country_iso: string | null; mapped: string | null; expect: string; uses_fallback: boolean; warning?: string }[])(
    '$id',
    ({ country_iso, mapped, expect: want, uses_fallback, warning }) => {
      const got = resolveTimeZone({ countryIso: country_iso, mapped, fallback: zoneGolden.fallback });
      expect(got.timeZone).toBe(want);
      expect(got.usesFallback).toBe(uses_fallback);
      expect(got.warning).toBe(warning);
    },
  );

  it('every zone in the table is real', () => {
    const bad = Object.entries(COUNTRY_ZONES).filter(([, z]) => !isValidTimeZone(z));
    expect(bad).toEqual([]);
  });

  it('every country a phone can resolve to has a zone', () => {
    // Countries with no entry in tzdb's zone table fall back rather than guess, so list them explicitly.
    expect(getCountries().filter((c) => !countryZone(c))).toEqual(['AC', 'TA', 'XK']);
  });

  it('reads a mapped country as a code or a name, and never guesses', () => {
    expect(parseCountry('de')).toBe('DE');
    expect(parseCountry('Germany')).toBe('DE');
    expect(parseCountry('UK')).toBe('GB');
    expect(parseCountry('Narnia')).toBeNull();
    expect(parseCountry('')).toBeNull();
  });
});
