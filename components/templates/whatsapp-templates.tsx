'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { EmptyState } from '@/components/shell/empty-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchJson } from '@/lib/client/fetch-json';
import type { TemplateView } from '@/lib/whatsapp/templates';

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** §5.6 S-05, WhatsApp tab. Templates are written and approved in WhatsApp Manager, then synced here. */
export function WhatsAppTemplates() {
  const client = useQueryClient();
  const templates = useQuery({ queryKey: ['whatsapp-templates'], queryFn: () => fetchJson<{ items: TemplateView[] }>('/api/whatsapp/templates') });
  const sync = useMutation({
    mutationFn: () => fetchJson<{ synced: number; removed: number }>('/api/whatsapp/templates/sync', { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['whatsapp-templates'] }),
  });
  const items = templates.data?.items ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? 'Syncing…' : 'Sync from Meta'}</Button>
        <a className="text-sm underline underline-offset-2" href="https://business.facebook.com/wa/manage/message-templates/" target="_blank" rel="noreferrer">Create templates in WhatsApp Manager</a>
        {sync.isSuccess && <span className="text-sm text-muted-foreground" role="status">{sync.data.synced} {sync.data.synced === 1 ? 'template' : 'templates'} synced.</span>}
      </div>
      {(sync.error ?? templates.error) && (
        <Alert variant="destructive">
          <AlertDescription>{(sync.error ?? templates.error)!.message}</AlertDescription>
        </Alert>
      )}
      {!templates.data && !templates.error ? (
        <Skeleton className="h-32 w-full" />
      ) : items.length === 0 ? (
        <EmptyState icon={FileText} title="No WhatsApp templates yet" description="WhatsApp only lets businesses start a conversation with a template Meta has approved. Create one in WhatsApp Manager, then choose Sync from Meta." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Language</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Synced</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell>{t.language}</TableCell>
                <TableCell>{t.category ?? '—'}</TableCell>
                <TableCell><Badge variant={t.status === 'APPROVED' ? 'secondary' : t.status === 'REJECTED' || t.status === 'DISABLED' ? 'destructive' : 'outline'}>{t.status}</Badge></TableCell>
                <TableCell className="max-w-96 whitespace-normal text-muted-foreground">
                  {t.body}
                  {t.rejected_reason && <span className="block text-destructive">Rejected: {t.rejected_reason}</span>}
                  {t.unsupported && <span className="block">Can’t be sent from here: {t.unsupported}</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{t.last_synced_at ? dateTime.format(new Date(t.last_synced_at)) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
