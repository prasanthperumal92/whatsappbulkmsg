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
const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pg'), user: 'postgres', password: 'postgres', port: pgPort, persistent: false, onLog: () => {} });

async function main() {
  await pg.initialise();
  await pg.start();
  const url = `postgres://postgres:postgres@localhost:${pgPort}/postgres`;
  await runMigrations(url, ['member@example.com']);

  const next = spawn('npx', ['next', 'dev', '--port', String(port)], {
    stdio: 'inherit',
    // BLOB_READ_WRITE_TOKEN is blanked because Next would otherwise load it from .env.local and use the real store.
    // LOCAL_BIN_FILE points nowhere so a real Resend key in .local.bin can't reach these tests (§7A.1).
    env: { ...process.env, DATABASE_URL: url, E2E_FAKE_CLERK: '1', LOCAL_BLOB_DIR: path.join(dir, 'blob'), BLOB_READ_WRITE_TOKEN: '', LOCAL_BIN_FILE: process.env.LOCAL_BIN_FILE ?? path.join(dir, 'no-local-bin') },
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
