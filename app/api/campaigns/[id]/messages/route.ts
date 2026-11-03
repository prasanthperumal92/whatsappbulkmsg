import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { withSession } from '@/lib/api/route';
import { getCampaign, listCampaignMessages, MESSAGE_FILTERS } from '@/lib/campaigns/stats';

const query = z.object({
  filter: z.enum(MESSAGE_FILTERS).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = withSession(async (req, { db, params }) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Invalid filter or page');
  const id = params.id as string;
  await getCampaign(db, id);
  const { filter, page, page_size } = parsed.data;
  return Response.json(await listCampaignMessages(db, id, { filter, page, pageSize: page_size }));
});
