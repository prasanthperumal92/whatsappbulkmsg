import { withSession } from '@/lib/api/route';
import { describeImport } from '@/lib/imports/service';

export const GET = withSession(async (_req, { db, params }) => Response.json(await describeImport(db, params.id as string)));
