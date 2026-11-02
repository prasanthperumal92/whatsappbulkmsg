import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction: both run the same queries. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

// node-postgres against Neon's pooled URL supports interactive transactions (§3.2).
// The pool lives on globalThis so hot reload and Fluid Compute reuse connections.
const cache = globalThis as unknown as { __appPool?: Pool; __appDb?: Db };

export function getDb(): Db {
  if (cache.__appDb) return cache.__appDb;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  cache.__appPool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 10_000 });
  cache.__appDb = drizzle(cache.__appPool, { schema });
  return cache.__appDb;
}

export { schema };
