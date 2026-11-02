import { Users } from 'lucide-react';
import { AddContact } from '@/components/contacts/add-contact';
import { EmptyState } from '@/components/shell/empty-state';
import { PageHeader } from '@/components/shell/page-header';
import { ContactStore } from '@/lib/contacts/store';
import { getDb } from '@/lib/db';

export default async function ContactsPage() {
  const count = await new ContactStore(getDb()).count();
  return (
    <>
      <PageHeader title="Contacts" description={count > 0 ? `${count.toLocaleString('en-IN')} ${count === 1 ? 'contact' : 'contacts'}` : undefined} />
      <AddContact />
      {count === 0 && <EmptyState icon={Users} title="No contacts yet" description="Add a contact with the form, or import a CSV file." />}
    </>
  );
}
