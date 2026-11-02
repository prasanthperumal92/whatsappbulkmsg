import { COUNTRY_ZONES } from './zones';

// §4.8 country and time zone. Pure, so the browser and the server agree.

export type ZoneResolution = { timeZone: string | null; usesFallback: boolean; warning?: 'INVALID_TIME_ZONE' };

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const countryZone = (country: string | null | undefined) => (country ? (COUNTRY_ZONES[country.toUpperCase()] ?? null) : null);

/** A valid mapped zone wins, then the country's zone, then `fallback`. Without a fallback, an unknown zone is null. */
export function resolveTimeZone(input: { countryIso?: string | null; mapped?: string | null; fallback?: string | null }): ZoneResolution {
  const mapped = input.mapped?.trim() || null;
  const warning = mapped && !isValidTimeZone(mapped) ? ({ warning: 'INVALID_TIME_ZONE' } as const) : {};
  if (mapped && !warning.warning) return { timeZone: mapped, usesFallback: false };
  const zone = countryZone(input.countryIso);
  if (zone) return { timeZone: zone, usesFallback: false, ...warning };
  return { timeZone: input.fallback ?? null, usesFallback: true, ...warning };
}

const NAME_TO_ISO: Map<string, string> = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const map = new Map<string, string>();
  for (const code of Object.keys(COUNTRY_ZONES)) {
    const name = names.of(code);
    if (name && name !== code) map.set(name.toLowerCase(), code);
  }
  for (const [alias, code] of Object.entries({ usa: 'US', 'united states of america': 'US', uk: 'GB', uae: 'AE', england: 'GB', scotland: 'GB', wales: 'GB' })) {
    map.set(alias, code);
  }
  return map;
})();

/** Reads a mapped country cell: an ISO code or an English name. Anything else is ignored, not guessed. */
export function parseCountry(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (COUNTRY_ZONES[upper]) return upper;
  return NAME_TO_ISO.get(value.toLowerCase()) ?? null;
}
