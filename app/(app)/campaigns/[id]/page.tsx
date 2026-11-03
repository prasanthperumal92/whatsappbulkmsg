import { CampaignMonitor } from '@/components/campaigns/campaign-monitor';

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  return <CampaignMonitor id={(await params).id} />;
}
