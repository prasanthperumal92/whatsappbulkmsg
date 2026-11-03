import { withSession } from '@/lib/api/route';
import { getCampaign } from '@/lib/campaigns/stats';

export const GET = withSession(async (_req, { db, params }) => Response.json(await getCampaign(db, params.id as string)));
