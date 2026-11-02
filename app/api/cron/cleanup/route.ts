import { withCron } from '@/lib/api/route';
import { getDb } from '@/lib/db';
import { runCleanup } from '@/lib/snapshots/service';

export const GET = withCron(async () => Response.json(await runCleanup(getDb())));
