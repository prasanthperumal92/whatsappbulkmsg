import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inject } from 'vitest';

process.env.DATABASE_URL = inject('databaseUrl');

// A directory of its own, so tests never see files from local dev.
process.env.LOCAL_BLOB_DIR = mkdtempSync(path.join(tmpdir(), 'wa-blob-'));
