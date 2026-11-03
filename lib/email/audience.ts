import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normaliseEmail } from '@/lib/contacts/email';
import { ContactStore, type ContactRow } from '@/lib/contacts/store';
import { schema, type Tx } from '@/lib/db';
import type { Settings } from '@/lib/settings/schema';

// §5.8 step 1 for email: who a selection actually reaches, and why the rest don't.

const { contactActivity, emailSuppressionList } = schema;

export const selection = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ids'), ids: z.array(z.uuid()).min(1).max(50_000) }),
  z.object({ mode: z.literal('filter'), q: z.string().max(200).default(''), exclude_ids: z.array(z.uuid()).max(50_000).default([]) }),
]);
export type Selection = z.output<typeof selection>;

export const EXCLUSIONS = ['deleted', 'no_email', 'suppressed', 'opted_out', 'unknown_consent', 'frequency_cap', 'duplicate_address'] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];

export type AudiencePlan = {
  selected: number;
  recipients: ContactRow[];
  excluded: Record<Exclusion, number>;
  role_addresses: number;
};

export type AudienceInput = {
  contacts: ContactRow[];
  suppressed: Set<string>;
  lastEmailed: Map<string, Date>;
  frequencyCapDays: number;
  unknownConsentLimit: number;
  strictConsentCountries: string[];
  includeUnknown: boolean;
  now: Date;
};

const DAY = 24 * 60 * 60 * 1000;

/** Pure. Contacts are taken earliest `contact_id` first, for both the duplicate rule and the unknown-consent limit. */
export function planAudience({ contacts, suppressed, lastEmailed, frequencyCapDays, unknownConsentLimit, strictConsentCountries, includeUnknown, now }: AudienceInput): AudiencePlan {
  const excluded = Object.fromEntries(EXCLUSIONS.map((e) => [e, 0])) as Record<Exclusion, number>;
  const recipients: ContactRow[] = [];
  const addresses = new Set<string>();
  const strict = new Set(strictConsentCountries);
  let unknownIncluded = 0;
  let role_addresses = 0;

  for (const contact of [...contacts].sort((a, b) => a.contact_id.localeCompare(b.contact_id))) {
    const { email, role } = normaliseEmail(contact.email);
    const last = lastEmailed.get(contact.contact_id);
    const unknown = contact.email_opt_in_status === 'unknown';
    const reason: Exclusion | null = contact.is_deleted
      ? 'deleted'
      : !email
        ? 'no_email'
        : suppressed.has(email)
          ? 'suppressed'
          : contact.email_opt_in_status === 'opted_out'
            ? 'opted_out'
            // D15: strict-consent countries, and contacts with no known country, stay excluded whatever the toggle says.
            : unknown && (!includeUnknown || !contact.country_iso || strict.has(contact.country_iso))
              ? 'unknown_consent'
              : frequencyCapDays > 0 && last && now.getTime() - last.getTime() < frequencyCapDays * DAY
                ? 'frequency_cap'
                : addresses.has(email)
                  ? 'duplicate_address'
                  : unknown && unknownIncluded >= unknownConsentLimit
                    ? 'unknown_consent'
                    : null;
    if (reason) {
      excluded[reason]++;
      continue;
    }
    addresses.add(email!);
    if (unknown) unknownIncluded++;
    if (role) role_addresses++;
    recipients.push({ ...contact, email: email! });
  }
  return { selected: contacts.length, recipients, excluded, role_addresses };
}

export async function loadSelection(db: Tx, chosen: Selection): Promise<ContactRow[]> {
  const store = new ContactStore(db);
  if (chosen.mode === 'ids') return store.getMany([...new Set(chosen.ids)]);
  const excluded = new Set(chosen.exclude_ids);
  return (await store.listMatching(chosen.q)).filter((c) => !excluded.has(c.contact_id));
}

export async function resolveAudience(db: Tx, chosen: Selection, settings: Pick<Settings, 'emailSending' | 'audience'>, includeUnknown: boolean, now = new Date()): Promise<AudiencePlan> {
  const contacts = await loadSelection(db, chosen);
  const addresses = contacts.flatMap((c) => (c.email ? [c.email] : []));
  const ids = contacts.map((c) => c.contact_id);
  const suppressedRows = addresses.length ? await db.select({ email: emailSuppressionList.email }).from(emailSuppressionList).where(inArray(emailSuppressionList.email, addresses)) : [];
  const activity = ids.length ? await db.select({ id: contactActivity.contactId, at: contactActivity.lastEmailAt }).from(contactActivity).where(inArray(contactActivity.contactId, ids)) : [];
  return planAudience({
    contacts,
    suppressed: new Set(suppressedRows.map((r) => r.email)),
    lastEmailed: new Map(activity.flatMap((a) => (a.at ? [[a.id, a.at] as const] : []))),
    frequencyCapDays: settings.emailSending.frequencyCapDays,
    unknownConsentLimit: settings.audience.unknownConsentLimit,
    strictConsentCountries: settings.audience.strictConsentCountries,
    includeUnknown,
    now,
  });
}

const IST_OFFSET = 5.5 * 60 * 60 * 1000;

/** §7A.6: quotas reset on the IST day and month. Pure. */
export function capWindows(now: Date) {
  const ist = new Date(now.getTime() + IST_OFFSET);
  return {
    hour: new Date(now.getTime() - 60 * 60 * 1000),
    day: new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET),
    month: new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET),
  };
}

/** A send this size is one stage (§7A.5), so a bigger one needs the campaign engine's stages and circuit breaker. */
export const MAX_DIRECT_RECIPIENTS = 500;

/** How many more emails the caps allow right now, and which cap is the tightest. */
export async function capacity(db: Tx, { dailyCap, monthlyCap, hourlyCap }: Settings['emailSending'], now = new Date()) {
  const { hour, day, month } = capWindows(now);
  const earliest = hour < month ? hour : month;
  const { rows } = await db.execute<{ hour: number; day: number; month: number }>(sql`
    SELECT count(*) FILTER (WHERE accepted_at >= ${hour.toISOString()}::timestamptz)::int AS hour,
           count(*) FILTER (WHERE accepted_at >= ${day.toISOString()}::timestamptz)::int AS day,
           count(*) FILTER (WHERE accepted_at >= ${month.toISOString()}::timestamptz)::int AS month
    FROM campaign_messages WHERE channel = 'email' AND accepted_at >= ${earliest.toISOString()}::timestamptz`);
  const used = rows[0]!;
  const limits = [
    { label: 'the limit per send', left: MAX_DIRECT_RECIPIENTS },
    { label: "today's send cap", left: dailyCap - used.day },
    { label: "this hour's send cap", left: hourlyCap - used.hour },
    { label: "this month's send cap", left: monthlyCap - used.month },
  ];
  const tightest = limits.reduce((a, b) => (b.left < a.left ? b : a));
  return { remaining: Math.max(0, tightest.left), label: tightest.label };
}
