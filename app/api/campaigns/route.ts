import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { withSession } from '@/lib/api/route';
import { listCampaigns } from '@/lib/campaigns/stats';
import { CHANNELS } from '@/lib/db/schema';

const query = z.object({
  channel: z.enum(CHANNELS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

export const GET = withSession(async (req, { db }) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Invalid channel or page');
  const { channel, page, page_size } = parsed.data;
  return Response.json(await listCampaigns(db, { channel, page, pageSize: page_size }));
});
