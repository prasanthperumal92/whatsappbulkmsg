'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { selectClass } from '@/components/imports/types';
import { PageHeader } from '@/components/shell/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchJson } from '@/lib/client/fetch-json';
import type { CampaignDetail, CampaignMessage, MessageFilter } from '@/lib/campaigns/stats';
import { CampaignStatusBadge, DeliveryBar } from './campaign-parts';

const PAGE_SIZE = 50;
const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const FILTERS: [MessageFilter, string][] = [
  ['all', 'All recipients'],
  ['problems', 'Failed, bounced or complained'],
  ['delivered', 'Delivered'],
  ['waiting', 'Waiting for an update'],
  ['skipped', 'Skipped'],
  ['unknown', 'Unknown'],
];

const MESSAGE_STATUS: Record<string, string> = {
  pending: 'Pending', claimed: 'Pending', retry_wait: 'Retrying', sending: 'Sending', accepted: 'Accepted', sent: 'Sent', delayed: 'Delayed', delivered: 'Delivered',
  opened: 'Opened', clicked: 'Clicked', bounced: 'Bounced', complained: 'Complained', failed: 'Failed', skipped: 'Skipped', unknown: 'Unknown',
};
const SKIP_REASON: Record<string, string> = {
  SUPPRESSED: 'On the suppression list',
  EMPTY_VARIABLE: 'A variable had no value',
  NO_EMAIL: 'No email address',
  SEND_STOPPED: 'The send stopped first',
};

const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—');

function Tile({ label, value, note, level }: { label: string; value: number; note?: string; level?: 'near' | 'over' | null }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString('en-IN')}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {level && (
        <Badge variant={level === 'over' ? 'destructive' : 'outline'} className="mt-1">
          <TriangleAlert aria-hidden />
          {level === 'over' ? 'Over the limit' : 'Near the limit'}
        </Badge>
      )}
    </div>
  );
}

/** §5.9: amber as a rate approaches the circuit-breaker threshold, red once it's reached. */
function levelOf(part: number, whole: number, threshold: number) {
  if (!whole || !part) return null;
  const rate = (part / whole) * 100;
  return rate >= threshold ? 'over' : rate >= threshold / 2 ? 'near' : null;
}

function describeMessage(m: CampaignMessage) {
  if (m.status === 'skipped') return SKIP_REASON[m.error_code ?? ''] ?? m.error_code ?? '';
  if (m.status === 'unknown') return 'May or may not have gone out';
  if (m.bounce_type) return [m.bounce_type, m.bounce_subtype, m.error_detail].filter(Boolean).join(' · ');
  return m.error_detail ?? (m.unsubscribed ? 'Unsubscribed' : '');
}

function Recipients({ id, running }: { id: string; running: boolean }) {
  const [filter, setFilter] = useState<MessageFilter>('all');
  const [page, setPage] = useState(1);
  const messages = useQuery({
    queryKey: ['campaign-messages', id, filter, page],
    queryFn: () => fetchJson<{ items: CampaignMessage[]; total: number }>(`/api/campaigns/${encodeURIComponent(id)}/messages?${new URLSearchParams({ filter, page: String(page), page_size: String(PAGE_SIZE) })}`),
    placeholderData: keepPreviousData,
    refetchInterval: running ? 2_000 : 10_000,
  });
  const pages = Math.max(1, Math.ceil((messages.data?.total ?? 0) / PAGE_SIZE));
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Recipients</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-filter">Show</Label>
            <select id="campaign-filter" className={selectClass} value={filter} onChange={(e) => { setFilter(e.target.value as MessageFilter); setPage(1); }}>
              {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <a className={buttonVariants({ variant: 'outline' })} href={`/api/campaigns/${encodeURIComponent(id)}/failures`}>Export failures as CSV</a>
        </div>
        {messages.error ? (
          <Alert variant="destructive">
            <AlertDescription>{messages.error.message}</AlertDescription>
          </Alert>
        ) : !messages.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.data.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">Nobody here.</TableCell>
                </TableRow>
              )}
              {messages.data.items.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.email_to ?? '—'}</TableCell>
                  <TableCell>{[m.first_name, m.last_name].filter(Boolean).join(' ') || '—'}</TableCell>
                  <TableCell>{MESSAGE_STATUS[m.status] ?? m.status}</TableCell>
                  <TableCell className="max-w-80 whitespace-normal text-muted-foreground">{describeMessage(m)}</TableCell>
                  <TableCell className="text-muted-foreground">{dateTime.format(new Date(m.updated_at))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {pages > 1 && (
          <div className="flex items-center gap-3">
            <Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="text-sm text-muted-foreground">Page {page} of {pages}</span>
            <Button variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** §5.9 S-08, for email. A send finishes within its own request, so it has no pause or resume to offer. */
export function CampaignMonitor({ id }: { id: string }) {
  const campaign = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => fetchJson<CampaignDetail>(`/api/campaigns/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2_000 : 10_000),
  });
  const back = (
    <Link href="/campaigns" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
      <ArrowLeft className="size-4" aria-hidden />
      Campaigns
    </Link>
  );
  if (campaign.error) {
    return (
      <>
        {back}
        <Alert variant="destructive">
          <AlertDescription>{campaign.error.message}</AlertDescription>
        </Alert>
      </>
    );
  }
  if (!campaign.data) return <Skeleton className="h-64 w-full" />;
  const c = campaign.data;
  const n = c.counts;

  return (
    <>
      {back}
      <PageHeader title={c.name} description={`${c.created_by_email ? `Sent by ${c.created_by_email}, ` : ''}${dateTime.format(new Date(c.created_at))}`} />
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <CampaignStatusBadge status={c.status} />
        </div>
        {c.stopped_reason && (
          <Alert variant="destructive">
            <AlertDescription>{c.stopped_reason}</AlertDescription>
          </Alert>
        )}
        {!c.webhook_connected && n.accepted > 0 && (
          <Alert>
            <AlertDescription>
              Delivered, opened and bounced counts stay at zero until Resend can report them. <Link className="underline underline-offset-2" href="/settings">Connect the webhook in Settings</Link>.
            </AlertDescription>
          </Alert>
        )}
        <DeliveryBar counts={n} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Tile label="Recipients" value={n.total} />
          <Tile label="Accepted by Resend" value={n.accepted} />
          <Tile label="Delivered" value={n.delivered} note={`${share(n.delivered, n.accepted)} of accepted`} />
          <Tile label="Opened (approximate)" value={n.opened} note={`${share(n.opened, n.delivered)} of delivered`} />
          <Tile label="Clicked" value={n.clicked} note={`${share(n.clicked, n.delivered)} of delivered`} />
          <Tile label="Bounced" value={n.bounced} note={`${share(n.bounced, n.accepted)} of accepted`} level={levelOf(n.bounced, n.accepted, c.thresholds.bounce)} />
          <Tile label="Complained" value={n.complained} note={`${share(n.complained, n.accepted)} of accepted`} level={levelOf(n.complained, n.accepted, c.thresholds.complaint)} />
          <Tile label="Unsubscribed" value={n.unsubscribed} />
          <Tile label="Failed" value={n.failed} />
          <Tile label="Skipped" value={n.skipped} />
          <Tile label="Unknown" value={n.unknown} note="May or may not have gone out" />
          {n.pending > 0 && <Tile label="Pending" value={n.pending} />}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Message</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {c.from && <p><span className="text-muted-foreground">From:</span> {c.from}</p>}
            {c.reply_to && <p><span className="text-muted-foreground">Reply-to:</span> {c.reply_to}</p>}
            <p className="whitespace-pre-wrap">{c.message}</p>
          </CardContent>
        </Card>

        {c.top_links.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Top links</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Link</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {c.top_links.map((link) => (
                    <TableRow key={link.url}>
                      <TableCell className="max-w-96 truncate">{link.url}</TableCell>
                      <TableCell className="text-right tabular-nums">{link.clicks.toLocaleString('en-IN')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <Recipients id={id} running={c.status === 'running'} />
      </div>
    </>
  );
}
