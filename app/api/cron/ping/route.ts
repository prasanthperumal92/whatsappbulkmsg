import { withCron } from '@/lib/api/route';

// Unscheduled. Lets deployments and SEC-03 confirm that CRON_SECRET is configured correctly.
export const GET = withCron(async () => Response.json({ ok: true }));
