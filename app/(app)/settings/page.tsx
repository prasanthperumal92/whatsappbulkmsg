import { PageHeader } from '@/components/shell/page-header';
import { EmailSection } from '@/components/settings/email-section';
import { SignatureSection } from '@/components/settings/signature-section';
import { WebhookSection } from '@/components/settings/webhook-section';
import { ImportSection } from '@/components/settings/import-section';
import { TeamSection } from '@/components/team/team-section';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="More sections arrive as each channel is built." />
      <div className="max-w-2xl space-y-6">
        <EmailSection />
        <SignatureSection />
        <WebhookSection />
        <ImportSection />
        <TeamSection />
      </div>
    </>
  );
}
