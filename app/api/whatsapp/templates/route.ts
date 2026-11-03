import { withSession } from '@/lib/api/route';
import { listTemplateViews } from '@/lib/whatsapp/templates';

export const GET = withSession(async (_req, { db }) => Response.json({ items: await listTemplateViews(db) }));
