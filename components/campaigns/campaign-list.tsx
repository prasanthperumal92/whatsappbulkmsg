'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Mail, Megaphone, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/shell/empty-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchJson } from '@/lib/client/fetch-json';
import type { CampaignSummary } from '@/lib/campaigns/stats';
import { CampaignStatusBadge } from './campaign-parts';

const PAGE_SIZE = 25;
const dateTime = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const rate = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

/** §5.10 S-09. */
export function CampaignList() {
  const [page, setPage] = useState(1);
  const campaigns = useQuery({
    queryKey: ['campaigns', page],
    queryFn: () => fetchJson<{ items: CampaignSummary[]; total: number }>(`/api/campaigns?page=${page}&page_size=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  if (campaigns.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{campaigns.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (!campaigns.data) return <Skeleton className="h-40 w-full" />;
  const { items, total } = campaigns.data;
  if (total === 0) return <EmptyState icon={Megaphone} title="No campaigns yet" description="Select contacts on the Contacts page, then choose WhatsApp selected or Email selected. Each send appears here, with its delivery progress." />;
  const pages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Campaign</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sent by</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Recipients</TableHead>
            <TableHead className="text-right">Delivered</TableHead>
            <TableHead className="text-right">Opened / read</TableHead>
            <TableHead className="text-right">Clicked</TableHead>
            <TableHead className="text-right">Bounced</TableHead>
            <TableHead className="text-right">Opt-outs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="max-w-72 font-medium">
                <Link href={`/campaigns/${c.id}`} className="flex items-center gap-2 underline-offset-2 hover:underline">
                  {c.channel === 'whatsapp' ? <MessageCircle className="size-4 shrink-0 text-muted-foreground" aria-label="WhatsApp" /> : <Mail className="size-4 shrink-0 text-muted-foreground" aria-label="Email" />}
                  <span className="truncate">{c.name}</span>
                </Link>
              </TableCell>
              <TableCell><CampaignStatusBadge status={c.status} /></TableCell>
              <TableCell className="text-muted-foreground">{c.created_by_email ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground">{dateTime.format(new Date(c.created_at))}</TableCell>
              <TableCell className="text-right tabular-nums">{c.counts.total.toLocaleString('en-IN')}</TableCell>
              <TableCell className="text-right tabular-nums">{rate(c.counts.delivered, c.counts.accepted)}</TableCell>
              <TableCell className="text-right tabular-nums">{c.channel === 'whatsapp' ? rate(c.counts.read, c.counts.delivered) : rate(c.counts.opened, c.counts.delivered)}</TableCell>
              <TableCell className="text-right tabular-nums">{c.channel === 'whatsapp' ? '—' : rate(c.counts.clicked, c.counts.delivered)}</TableCell>
              <TableCell className="text-right tabular-nums">{c.channel === 'whatsapp' ? '—' : rate(c.counts.bounced, c.counts.accepted)}</TableCell>
              <TableCell className="text-right tabular-nums">{(c.counts.unsubscribed + c.counts.complained).toLocaleString('en-IN')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pages > 1 && (
        <div className="flex items-center gap-3">
          <Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page} of {pages}</span>
          <Button variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
