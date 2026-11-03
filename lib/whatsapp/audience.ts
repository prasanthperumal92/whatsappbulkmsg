import { inArray, sql } from 'drizzle-orm';
import type { ContactRow } from '@/lib/contacts/store';
import { schema, type Tx } from '@/lib/db';
import { loadSelection, type Selection } from '@/lib/email/audience';
import type { Settings } from '@/lib/settings/schema';

// §5.8 step 1 for WhatsApp: who a selection actually reaches, and why the rest don't.

const { contactActivity, suppressionList } = schema;

export const WHATSAPP_EXCLUSIONS = ['deleted', 'no_phone', 'suppressed', 'opted_out', 'restricted_country', 'unknown_consent', 'frequency_cap', 'empty_variable'] as const;
export type WhatsAppExclusion = (typeof WHATSAPP_EXCLUSIONS)[number];

export type WhatsAppPlan = { selected: number; recipients: ContactRow[]; excluded: Record<WhatsAppExclusion, number> };

export type WhatsAppAudienceInput = {
  contacts: ContactRow[];
  suppressed: Set<string>;
  lastMessaged: Map<string, Date>;
  frequencyCapDays: number;
  unknownConsentLimit: number;
  strictConsentCountries: string[];
  restrictedCountries: string[];
  includeUnknown: boolean;
  now: Date;
};

const DAY = 24 * 60 * 60 * 1000;

/** Pure. Contacts are taken earliest `contact_id` first for the unknown-consent limit, as on email. */
export function planWhatsAppAudience({ contacts, suppressed, lastMessaged, frequencyCapDays, unknownConsentLimit, strictConsentCountries, restrictedCountries, includeUnknown, now }: WhatsAppAudienceInput): WhatsAppPlan {
  const excluded = Object.fromEntries(WHATSAPP_EXCLUSIONS.map((e) => [e, 0])) as Record<WhatsAppExclusion, number>;
  const recipients: ContactRow[] = [];
  const strict = new Set(strictConsentCountries);
  const restricted = new Set(restrictedCountries);
  let unknownIncluded = 0;

  for (const contact of [...contacts].sort((a, b) => a.contact_id.localeCompare(b.contact_id))) {
    const last = lastMessaged.get(contact.contact_id);
    const unknown = contact.opt_in_status === 'unknown';
    const reason: WhatsAppExclusion | null = contact.is_deleted
      ? 'deleted'
      : !contact.phone_e164 || !contact.wa_to
        ? 'no_phone'
        : suppressed.has(contact.phone_e164)
          ? 'suppressed'
          : contact.opt_in_status === 'opted_out'
            ? 'opted_out'
            : contact.country_iso && restricted.has(contact.country_iso)
              ? 'restricted_country'
              // D15: strict-consent countries, and contacts with no known country, stay excluded whatever the toggle says.
              : unknown && (!includeUnknown || !contact.country_iso || strict.has(contact.country_iso))
                ? 'unknown_consent'
                : frequencyCapDays > 0 && last && now.getTime() - last.getTime() < frequencyCapDays * DAY
                  ? 'frequency_cap'
                  : unknown && unknownIncluded >= unknownConsentLimit
                    ? 'unknown_consent'
                    : null;
    if (reason) {
      excluded[reason]++;
      continue;
    }
    if (unknown) unknownIncluded++;
    recipients.push(contact);
  }
  return { selected: contacts.length, recipients, excluded };
}

export async function resolveWhatsAppAudience(db: Tx, chosen: Selection, settings: Pick<Settings, 'whatsappSending' | 'audience'>, includeUnknown: boolean, now = new Date()): Promise<WhatsAppPlan> {
  const contacts = await loadSelection(db, chosen);
  const phones = contacts.flatMap((c) => (c.phone_e164 ? [c.phone_e164] : []));
  const ids = contacts.map((c) => c.contact_id);
  const suppressedRows = phones.length ? await db.select({ phone: suppressionList.phoneE164 }).from(suppressionList).where(inArray(suppressionList.phoneE164, phones)) : [];
  const activity = ids.length ? await db.select({ id: contactActivity.contactId, at: contactActivity.lastMarketingAt }).from(contactActivity).where(inArray(contactActivity.contactId, ids)) : [];
  return planWhatsAppAudience({
    contacts,
    suppressed: new Set(suppressedRows.map((r) => r.phone)),
    lastMessaged: new Map(activity.flatMap((a) => (a.at ? [[a.id, a.at] as const] : []))),
    frequencyCapDays: settings.whatsappSending.frequencyCapDays,
    unknownConsentLimit: settings.audience.unknownConsentLimit,
    strictConsentCountries: settings.audience.strictConsentCountries,
    restrictedCountries: settings.whatsappSending.restrictedCountries,
    includeUnknown,
    now,
  });
}

/** §7.6: `TIER_250`, `TIER_2K` and so on. Null when there's no fixed limit, or it isn't known. */
export function tierLimit(tier: string | null): number | null {
  const match = tier?.toUpperCase().match(/^TIER_(\d+)(K?)$/);
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : null;
}

/** People messaged in the last 24 hours, which is what Meta's messaging limit counts. */
export async function uniqueMessagedLastDay(db: Tx, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - DAY).toISOString();
  const { rows } = await db.execute<{ n: number }>(sql`SELECT count(DISTINCT phone_e164)::int AS n FROM campaign_messages WHERE channel = 'whatsapp' AND accepted_at >= ${since}::timestamptz`);
  return rows[0]!.n;
}

/** A send runs inside one request, so its size is bounded by how long a function may run. */
export const MAX_DIRECT_WHATSAPP = 500;
