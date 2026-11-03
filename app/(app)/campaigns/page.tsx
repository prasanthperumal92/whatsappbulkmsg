import Link from 'next/link';
import { CampaignList } from '@/components/campaigns/campaign-list';
import { PageHeader } from '@/components/shell/page-header';
import { buttonVariants } from '@/components/ui/button';

export default function CampaignsPage() {
  return (
    <>
      <PageHeader title="Campaigns" description="Every email you send, with its delivery progress." />
      <div className="mb-6">
        <Link className={buttonVariants()} href="/contacts">New email campaign</Link>
      </div>
      <CampaignList />
    </>
  );
}
