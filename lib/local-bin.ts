import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

// §7A.1: local credentials. Values here beat `.env*`, which is why this doesn't use process.loadEnvFile: that
// leaves variables already set alone. A missing file is fine, because email then stays on Mock.

export const LOCAL_BIN_KEYS = 'LOCAL_BIN_KEYS';

export function loadLocalBin(env: Record<string, string | undefined> = process.env, file = env.LOCAL_BIN_FILE ?? path.join(process.cwd(), '.local.bin')) {
  if (env.NODE_ENV === 'production' || !existsSync(file)) return;
  const values = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) env[key] = value;
  // Only so Settings can say where the key came from. Holds names, never values.
  env[LOCAL_BIN_KEYS] = Object.keys(values).join(',');
}
