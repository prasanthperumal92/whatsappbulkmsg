import { withSession } from '@/lib/api/route';
import { activeCommit } from '@/lib/imports/service';

export const GET = withSession(async (_req, { db }) => Response.json({ active: await activeCommit(db) }));
