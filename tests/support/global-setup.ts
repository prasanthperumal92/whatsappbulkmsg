import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { runMigrations } from '../../lib/db/migrate';

/**
 * Integration tests need real Postgres (partial indexes, advisory locks, pg_trgm).
 * Set TEST_DATABASE_URL to use a Neon test branch; otherwise a throwaway local
 * server runs. The target database is dropped and rebuilt from the migrations.
 */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop = async () => {};
  if (!url) {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-pg-'));
    const port = 54000 + Math.floor(Math.random() * 1000);
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    url = `postgres://postgres:postgres@localhost:${port}/postgres`;
    stop = async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  } else {
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await client.end();
  }
  await runMigrations(url);
  project.provide('databaseUrl', url);
  return stop;
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
