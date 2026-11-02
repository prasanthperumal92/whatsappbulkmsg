import { parseBootstrapEmails, runMigrations } from '../lib/db/migrate';

// Runs as a deploy step (T1.9). The direct URL is preferred, because Drizzle's
// migrator takes a session-level lock that a transaction pooler would not hold.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error('db:migrate: DATABASE_URL is not set');
  process.exit(1);
}

runMigrations(url, parseBootstrapEmails(process.env.TEAM_BOOTSTRAP_EMAILS))
  .then(() => console.log('db:migrate: up to date'))
  .catch((err: unknown) => {
    // The driver's message can include the host; never print the connection string itself.
    console.error('db:migrate: failed:', err instanceof Error ? err.message : 'unknown error');
    process.exit(1);
  });
