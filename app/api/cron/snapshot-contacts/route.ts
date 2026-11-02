import { withCron } from '@/lib/api/route';
import { getDb } from '@/lib/db';
import { createSnapshot, snapshotDue } from '@/lib/snapshots/service';

/** §10 hourly. A failure is recorded for the banner by `createSnapshot`, then surfaces as a failed cron run. */
export const GET = withCron(async () => {
  const db = getDb();
  if (!(await snapshotDue(db))) return Response.json({ created: false });
  const { version, row_count } = await createSnapshot(db, { reason: 'hourly', createdBy: 'system:cron' });
  return Response.json({ created: true, version, row_count });
});
