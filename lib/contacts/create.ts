import { v7 as uuidv7 } from 'uuid';
import { ApiError } from '@/lib/api/errors';
import { ContactIndex } from '@/lib/contacts/match';
import { ContactStore, type ContactRow } from '@/lib/contacts/store';
import type { Tx } from '@/lib/db';
import { parseCountry } from '@/lib/geo';
import { newContact } from '@/lib/imports/merge';
import type { Mapping } from '@/lib/imports/mapping';
import { buildReader, normaliseRow } from '@/lib/imports/rows';
import { getSettingsSection } from '@/lib/settings/store';
import { loadSuppressionSets } from '@/lib/suppression/service';

// One contact typed into a form. It uses the import's normalisation and consent rules (§4.5–§4.8), but it
// follows the §4.7 edit rule for identifiers: a person is present to correct the entry, so an unusable value
// or one another contact holds is refused rather than warned about or merged.

export type NewContactInput = {
  phone?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  city?: string;
  country?: string;
  /** Comma-separated. */
  tags?: string;
  consent_proof_ref?: string;
  whatsapp_consent_confirmed?: boolean;
  email_consent_confirmed?: boolean;
};

const COLUMNS = ['phone', 'email', 'first_name', 'last_name', 'company', 'city', 'country', 'tags', 'consent_proof_ref'] as const;
const MAPPING: Mapping = Object.fromEntries(COLUMNS.map((c, i) => [i, c === 'consent_proof_ref' ? 'consent_proof' : c]));
const READER = buildReader(MAPPING);

export async function createContact(tx: Tx, input: NewContactInput, actor: { id: string }): Promise<ContactRow> {
  if (!input.phone && !input.email) throw new ApiError(400, 'identifier_required', 'Enter a phone number or an email address.');
  const country = input.country ? parseCountry(input.country) : null;
  if (input.country && !country) throw new ApiError(400, 'invalid_country', 'Enter the country as a name or a two-letter code, for example India or IN.');

  const { defaultCountry } = await getSettingsSection(tx, 'import');
  const row = normaliseRow(
    COLUMNS.map((c) => input[c] ?? ''),
    0,
    READER,
    {
      // A number with no country code is read as the country entered on this form, if there is one.
      default_country: country ?? defaultCountry,
      tag_separator: ',',
      apply_tags: [],
      opt_in_value: input.whatsapp_consent_confirmed ? 'opted_in' : 'unknown',
      email_opt_in_value: input.email_consent_confirmed ? 'opted_in' : 'unknown',
      consent_proof_value: null,
    },
  );
  if (input.phone && !row.phone) throw new ApiError(400, 'invalid_phone', 'This is not a valid phone number. Check it, and include the country code if it is from another country.');
  if (input.email && row.invalid_email) throw new ApiError(400, 'invalid_email', 'This is not a valid email address.');

  const store = new ContactStore(tx);
  // Held until the transaction ends, so an import or another add can't take this identifier after the check below.
  await store.lockForImport();
  const holders = await store.identitiesMatching(row.phone, row.email);
  if (new ContactIndex(holders).match(row).action === 'match') {
    const what = row.phone && holders.some((h) => h.phone === row.phone) ? 'phone number' : 'email address';
    throw new ApiError(409, 'contact_exists', `A contact with this ${what} already exists.`);
  }

  const { phones, emails } = await loadSuppressionSets(tx);
  const contact = newContact(uuidv7(), row, {
    batchId: null,
    source: 'manual',
    now: new Date().toISOString(),
    userId: actor.id,
    suppressedPhones: phones,
    suppressedEmails: emails,
  });
  await store.bumpRevision();
  await store.insertMany([contact]);
  return contact;
}
