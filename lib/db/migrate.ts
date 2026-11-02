import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Client } from 'pg';
import { teamAllowlist } from './schema';

export function parseBootstrapEmails(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

/** Applies pending migrations, then seeds the first allowlist emails (H-3) if the list is empty. */
export async function runMigrations(connectionString: string, bootstrapEmails: string[] = []) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
    if (bootstrapEmails.length) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(teamAllowlist);
      if (row?.n === 0) {
        await db
          .insert(teamAllowlist)
          .values(bootstrapEmails.map((email) => ({ email, addedBy: 'system:bootstrap' })))
          .onConflictDoNothing();
      }
    }
  } finally {
    await client.end();
  }
}
