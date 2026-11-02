import { PageHeader } from '@/components/shell/page-header';
import { ActivityLog } from '@/components/activity/activity-log';

export default function ActivityPage() {
  return (
    <>
      <PageHeader title="Activity" description="Who did what, and when." />
      <ActivityLog />
    </>
  );
}
