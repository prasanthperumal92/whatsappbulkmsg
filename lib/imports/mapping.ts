// §5.3 Step 2: what each column means. Shared by the wizard and the server.

export const STANDARD_TARGETS = [
  'phone', 'email', 'first_name', 'last_name', 'display_name', 'company', 'city', 'language', 'tags', 'country', 'time_zone',
  'country_code', 'opt_in', 'email_opt_in', 'consent_proof',
] as const;
export type StandardTarget = (typeof STANDARD_TARGETS)[number];
/** A standard field, `custom:<name>` (stored in `attributes`), or null for Ignore. */
export type Target = StandardTarget | `custom:${string}` | null;
/** Column index → target. */
export type Mapping = Record<string, Target>;

export const TARGET_LABELS: Record<StandardTarget, string> = {
  phone: 'Phone', email: 'Email', first_name: 'First name', last_name: 'Last name', display_name: 'Display name', company: 'Company',
  city: 'City', language: 'Language', tags: 'Tags', country: 'Country', time_zone: 'Time zone', country_code: 'Country code',
  opt_in: 'WhatsApp opt-in', email_opt_in: 'Email opt-in', consent_proof: 'Consent proof',
};

const SYNONYMS: Record<StandardTarget, string[]> = {
  phone: ['phone', 'phone no', 'phone number', 'mobile', 'mobile no', 'mobile number', 'whatsapp', 'whatsapp no', 'whatsapp number', 'contact', 'contact no', 'contact number', 'cell', 'cell phone', 'number', 'telephone', 'tel'],
  email: ['email', 'e mail', 'email address', 'e mail address', 'mail'],
  first_name: ['name', 'first name', 'firstname', 'fname', 'given name', 'nom'], // `Name` → first_name is G-18.
  last_name: ['last name', 'lastname', 'lname', 'surname', 'family name'],
  display_name: ['display name', 'full name', 'fullname'],
  company: ['company', 'company name', 'organisation', 'organization', 'business', 'firm'],
  city: ['city', 'town', 'ville'],
  language: ['language', 'lang'],
  tags: ['tags', 'tag', 'segment', 'segments', 'group', 'groups', 'label', 'labels'],
  country: ['country', 'country iso', 'nation'],
  time_zone: ['time zone', 'timezone', 'tz'],
  country_code: ['country code', 'dial code', 'isd', 'isd code'],
  opt_in: ['opt in', 'optin', 'whatsapp opt in', 'whatsapp consent', 'consent'],
  email_opt_in: ['email opt in', 'email optin', 'email consent'],
  consent_proof: ['consent proof', 'consent proof ref', 'consent reference', 'proof'],
};

export function normaliseHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[_\-.:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LOOKUP = new Map<string, StandardTarget>(
  (Object.entries(SYNONYMS) as [StandardTarget, string[]][]).flatMap(([target, names]) => names.map((n) => [n, target] as const)),
);

/** Auto-suggestion. A target goes to the first column that claims it; only Tags can take several. */
export function suggestMapping(headers: string[]): Mapping {
  const used = new Set<StandardTarget>();
  const mapping: Mapping = {};
  headers.forEach((header, index) => {
    const target = LOOKUP.get(normaliseHeader(header)) ?? null;
    if (!target || (used.has(target) && target !== 'tags')) {
      mapping[index] = null;
      return;
    }
    used.add(target);
    mapping[index] = target;
  });
  return mapping;
}

/** Presets are matched by exact headers, in order, ignoring case and punctuation (FR-IMP-09). */
export const headerSignature = (headers: string[]) => headers.map(normaliseHeader).join('|');

/** A problem with the mapping, or null if it can be used. */
export function mappingProblem(mapping: Mapping): string | null {
  const targets = Object.values(mapping).filter((t): t is NonNullable<Target> => !!t);
  if (!targets.includes('phone') && !targets.includes('email')) return 'Map a Phone or Email column to continue.';
  const seen = new Set<string>();
  for (const target of targets) {
    if (target !== 'tags' && seen.has(target)) {
      const label = target.startsWith('custom:') ? target.slice(7) : TARGET_LABELS[target as StandardTarget];
      return `${label} can be used by only one column.`;
    }
    seen.add(target);
  }
  return null;
}
