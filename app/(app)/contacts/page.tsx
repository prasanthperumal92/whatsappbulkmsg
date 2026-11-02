import { Users } from 'lucide-react';
import { EmptyState } from '@/components/shell/empty-state';
import { PageHeader } from '@/components/shell/page-header';

export default function ContactsPage() {
  return (
    <>
      <PageHeader title="Contacts" />
      <EmptyState icon={Users} title="No contacts yet" description="Contacts you import from a CSV file will appear here." />
    </>
  );
}
