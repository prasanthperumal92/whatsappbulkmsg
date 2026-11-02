import { Upload } from 'lucide-react';
import { EmptyState } from '@/components/shell/empty-state';
import { PageHeader } from '@/components/shell/page-header';

export default function ImportPage() {
  return (
    <>
      <PageHeader title="Import contacts" />
      <EmptyState icon={Upload} title="No imports yet" description="CSV import isn't available yet. It arrives in the next phase of the build." />
    </>
  );
}
