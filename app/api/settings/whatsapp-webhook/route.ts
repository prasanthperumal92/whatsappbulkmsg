import { withSession } from '@/lib/api/route';
import { whatsappWebhookStatus } from '@/lib/whatsapp/webhook-status';

export const GET = withSession(async (req, { db }) => Response.json(await whatsappWebhookStatus(db, req.url)));
