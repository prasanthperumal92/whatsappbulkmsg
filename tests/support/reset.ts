import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';

const tables = [
  'campaign_messages', 'email_link_clicks', 'campaigns', 'templates', 'contact_import_changes', 'import_batches',
  'contacts', 'contact_snapshots', 'contact_erasures', 'mapping_presets', 'contact_activity', 'suppression_list',
  'email_suppression_list', 'whatsapp_identities', 'rate_limits', 'webhook_events', 'settings', 'audit_log', 'team_allowlist',
];

export async function resetDb() {
  const db = getDb();
  await db.execute(sql.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')}`));
  await db.execute(sql`UPDATE contact_revision SET revision = 0`);
}
