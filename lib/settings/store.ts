import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@/lib/db';
import { mockPolicy } from '@/lib/env';
import { SETTINGS_SECTIONS, settingsSchema, type Settings, type SettingsSection } from './schema';

const { settings } = schema;

function parseSection<K extends SettingsSection>(section: K, stored: unknown): Settings[K] {
  return settingsSchema[section].parse(stored ?? {}) as Settings[K];
}

/** Stored values over defaults. Reads only known sections, so the `secrets` row can't be returned. */
export async function getSettings(db: Tx): Promise<Settings> {
  const rows = await db.select().from(settings).where(inArray(settings.key, SETTINGS_SECTIONS));
  const byKey = new Map(rows.map((r) => [r.key, r.valueJson]));
  return Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s, parseSection(s, byKey.get(s))])) as Settings;
}

export async function getSettingsSection<K extends SettingsSection>(db: Tx, section: K): Promise<Settings[K]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, section));
  return parseSection(section, row?.valueJson);
}

export class SettingsValidationError extends Error {}

/** Partial update: `{ section: { field: value } }`. Validates all sections before writing any. */
export async function updateSettings(db: Tx, patch: unknown, env: Record<string, string | undefined> = process.env): Promise<SettingsSection[]> {
  const parsedPatch = z.partialRecord(z.enum(SETTINGS_SECTIONS as [SettingsSection, ...SettingsSection[]]), z.record(z.string(), z.unknown())).safeParse(patch);
  if (!parsedPatch.success) throw new SettingsValidationError('Unknown settings section');

  const sections = Object.keys(parsedPatch.data) as SettingsSection[];
  const next: { key: SettingsSection; value: unknown }[] = [];
  for (const section of sections) {
    const changes = parsedPatch.data[section]!;
    // §5.2: the provider choice appears on local dev only.
    if ('provider' in changes && (!mockPolicy(env).allowed || mockPolicy(env).forced)) {
      throw new SettingsValidationError('The provider can only be changed on local dev');
    }
    const [row] = await db.select().from(settings).where(eq(settings.key, section)).for('update');
    const merged = settingsSchema[section].safeParse({ ...(row?.valueJson as object | undefined), ...changes });
    if (!merged.success) {
      const issue = merged.error.issues[0];
      throw new SettingsValidationError(`${section}.${issue?.path.join('.')}: ${issue?.message}`);
    }
    next.push({ key: section, value: merged.data });
  }
  for (const { key, value } of next) {
    await db.insert(settings).values({ key, valueJson: value }).onConflictDoUpdate({ target: settings.key, set: { valueJson: value } });
  }
  return sections;
}
