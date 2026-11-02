import { Megaphone } from 'lucide-react';
import { EmptyState } from '@/components/shell/empty-state';
import { PageHeader } from '@/components/shell/page-header';

export default function CampaignsPage() {
  return (
    <>
      <PageHeader title="Campaigns" />
      <EmptyState icon={Megaphone} title="No campaigns yet" description="Campaigns you create will appear here, with their delivery progress." />
    </>
  );
}
