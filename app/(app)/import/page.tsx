import { ImportWizard } from '@/components/imports/import-wizard';
import { PageHeader } from '@/components/shell/page-header';

export default function ImportPage() {
  return (
    <>
      <PageHeader title="Import contacts" />
      <ImportWizard />
    </>
  );
}
