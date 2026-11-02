import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { runMigrations } from '../lib/db/migrate';

// Starts a throwaway Postgres and `next dev` with the fake Clerk module, for `npm run test:e2e:local`.
const port = Number(process.env.E2E_PORT ?? 3100);
const pgPort = port + 20000;
const dir = mkdtempSync(path.join(tmpdir(), 'wa-e2e-'));
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: pgPort, persistent: false, onLog: () => {} });

async function main() {
  await pg.initialise();
  await pg.start();
  const url = `postgres://postgres:postgres@localhost:${pgPort}/postgres`;
  await runMigrations(url, ['member@example.com']);

  const next = spawn('npx', ['next', 'dev', '--port', String(port)], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, E2E_FAKE_CLERK: '1' },
  });

  const stop = async () => {
    next.kill();
    await pg.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
