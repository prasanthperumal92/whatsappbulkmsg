import { FileText, Mail } from 'lucide-react';
import { EmptyState } from '@/components/shell/empty-state';
import { PageHeader } from '@/components/shell/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function TemplatesPage() {
  return (
    <>
      <PageHeader title="Templates" />
      <Tabs defaultValue="whatsapp">
        <TabsList>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
        </TabsList>
        <TabsContent value="whatsapp" className="mt-4">
          <EmptyState icon={FileText} title="No WhatsApp templates yet" description="WhatsApp templates you design will appear here." />
        </TabsContent>
        <TabsContent value="email" className="mt-4">
          <EmptyState icon={Mail} title="No email templates yet" description="Email templates you design will appear here." />
        </TabsContent>
      </Tabs>
    </>
  );
}
