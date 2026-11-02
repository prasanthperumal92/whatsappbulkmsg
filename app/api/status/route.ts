import { withSession } from '@/lib/api/route';
import { getAppStatus } from '@/lib/status';

export const GET = withSession(async (_req, { db }) => Response.json(await getAppStatus(db)));
