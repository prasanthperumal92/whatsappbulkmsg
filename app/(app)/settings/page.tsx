import { PageHeader } from '@/components/shell/page-header';
import { ImportSection } from '@/components/settings/import-section';
import { TeamSection } from '@/components/team/team-section';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="More sections arrive as each channel is built." />
      <div className="max-w-2xl space-y-6">
        <ImportSection />
        <TeamSection />
      </div>
    </>
  );
}
