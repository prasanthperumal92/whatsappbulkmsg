import { withSession } from '@/lib/api/route';
import { emailWebhookStatus } from '@/lib/email/webhook-status';

export const GET = withSession(async (req, { db }) => Response.json(await emailWebhookStatus(db, req.url)));
