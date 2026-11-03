'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchJson } from '@/lib/client/fetch-json';
import type { ContactRow } from '@/lib/contacts/store';
import type { Selection } from '@/lib/email/audience';
import type { SendSummary } from '@/lib/email/send';
import { EmailCompose } from './email-compose';
import { WhatsAppCompose } from './whatsapp-compose';

type Row = ContactRow & { last_email_at: string | null };
type Page = { items: Row[]; total: number };

const PAGE_SIZE = 100;
const dateFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });
const nameOf = (c: Row) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.display_name || '—';

function ConsentBadge({ status }: { status: string }) {
  if (status === 'opted_in') return <Badge variant="secondary">Opted in</Badge>;
  if (status === 'opted_out') return <Badge variant="destructive">Opted out</Badge>;
  return <Badge variant="outline">Unknown</Badge>;
}

function resultMessage({ accepted, failed, skipped, unknown }: SendSummary) {
  const parts = [`Sent to ${accepted} ${accepted === 1 ? 'contact' : 'contacts'}.`];
  if (skipped) parts.push(`${skipped} skipped, because they opted out or a variable in the message had no value for them.`);
  if (failed) parts.push(`${failed} failed.`);
  if (unknown) parts.push(`${unknown} may or may not have gone out.`);
  return parts.join(' ');
}

/** §5.4 S-03: search, paging and a selection that survives both. */
export function ContactsTable() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  /** "Select all matching": everyone the search finds, except the ones unticked since. */
  const [all, setAll] = useState<{ q: string; total: number; excluded: ReadonlySet<string> } | null>(null);
  const [composing, setComposing] = useState<'email' | 'whatsapp' | null>(null);
  const [result, setResult] = useState<SendSummary | null>(null);
  const lastClicked = useRef<number | null>(null);
  const headerBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
      lastClicked.current = null;
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const contacts = useQuery({
    queryKey: ['contacts', q, page],
    queryFn: () => fetchJson<Page>(`/api/contacts?${new URLSearchParams({ q, page: String(page), page_size: String(PAGE_SIZE) })}`),
    placeholderData: keepPreviousData,
  });
  const items = contacts.data?.items ?? [];
  const total = contacts.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const isSelected = (id: string) => (all ? !all.excluded.has(id) : ids.has(id));
  const selectedCount = all ? all.total - all.excluded.size : ids.size;
  const selectedOnPage = items.filter((c) => isSelected(c.contact_id)).length;
  const pageFullySelected = items.length > 0 && selectedOnPage === items.length;

  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = selectedOnPage > 0 && !pageFullySelected;
  }, [selectedOnPage, pageFullySelected]);

  const setMany = (rows: string[], on: boolean) => {
    setResult(null);
    if (all) {
      const excluded = new Set(all.excluded);
      rows.forEach((id) => (on ? excluded.delete(id) : excluded.add(id)));
      setAll({ ...all, excluded });
      return;
    }
    setIds((current) => {
      const next = new Set(current);
      rows.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  };

  const clear = () => {
    setIds(new Set());
    setAll(null);
    setComposing(null);
    lastClicked.current = null;
  };

  const toggleRow = (index: number, on: boolean, shift: boolean) => {
    const from = shift && lastClicked.current !== null ? Math.min(lastClicked.current, index) : index;
    const to = shift && lastClicked.current !== null ? Math.max(lastClicked.current, index) : index;
    setMany(items.slice(from, to + 1).map((c) => c.contact_id), on);
    lastClicked.current = index;
  };

  const onSent = (summary: SendSummary) => {
    setResult(summary);
    clear();
    void contacts.refetch();
  };

  const selection: Selection = all ? { mode: 'filter', q: all.q, exclude_ids: [...all.excluded] } : { mode: 'ids', ids: [...ids] };

  return (
    <div className="space-y-4">
      {result && (
        <Alert variant={result.stopped_reason ? 'destructive' : 'default'}>
          <AlertDescription>
            {resultMessage(result)}
            {result.stopped_reason && ` The send stopped: ${result.stopped_reason}`}{' '}
            <Link className="underline underline-offset-2" href={`/campaigns/${result.campaign_id}`}>View campaign</Link>
          </AlertDescription>
        </Alert>
      )}

      {composing === 'email' && selectedCount > 0 && <EmailCompose selection={selection} selectedCount={selectedCount} onCancel={() => setComposing(null)} onSent={onSent} />}
      {composing === 'whatsapp' && selectedCount > 0 && <WhatsAppCompose selection={selection} selectedCount={selectedCount} onCancel={() => setComposing(null)} onSent={onSent} />}

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          type="search"
          aria-label="Search contacts"
          placeholder="Search name, phone or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {selectedCount > 0 && (
          <div className="flex items-center gap-2" role="status">
            <span className="text-sm font-medium">{selectedCount.toLocaleString('en-IN')} selected</span>
            {!composing && (
              <>
                <Button onClick={() => setComposing('whatsapp')}>WhatsApp selected</Button>
                <Button variant="outline" onClick={() => setComposing('email')}>Email selected</Button>
              </>
            )}
            <Button variant="ghost" onClick={clear}>Clear</Button>
          </div>
        )}
      </div>

      {pageFullySelected && !all && total > items.length && (
        <p className="text-sm text-muted-foreground">
          {items.length} selected on this page.{' '}
          <Button variant="link" className="h-auto p-0" onClick={() => setAll({ q, total, excluded: new Set() })}>
            Select all {total.toLocaleString('en-IN')} matching contacts
          </Button>
        </p>
      )}

      {contacts.error ? (
        <Alert variant="destructive">
          <AlertDescription>{contacts.error.message}</AlertDescription>
        </Alert>
      ) : !contacts.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    ref={headerBox}
                    type="checkbox"
                    className="size-4 align-middle"
                    aria-label="Select all contacts on this page"
                    disabled={items.length === 0}
                    checked={pageFullySelected}
                    onChange={(e) => setMany(items.map((c) => c.contact_id), e.target.checked)}
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>WhatsApp opt-in</TableHead>
                <TableHead>Email opt-in</TableHead>
                <TableHead>Last emailed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No contacts match this search.</TableCell>
                </TableRow>
              )}
              {items.map((contact, index) => (
                <TableRow key={contact.contact_id} data-state={isSelected(contact.contact_id) ? 'selected' : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4 align-middle"
                      aria-label={`Select ${nameOf(contact)}`}
                      checked={isSelected(contact.contact_id)}
                      onChange={(e) => toggleRow(index, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{nameOf(contact)}</TableCell>
                  <TableCell>{contact.email ?? '—'}</TableCell>
                  <TableCell>{contact.phone_e164 ?? '—'}</TableCell>
                  <TableCell>{contact.company ?? '—'}</TableCell>
                  <TableCell><ConsentBadge status={contact.opt_in_status} /></TableCell>
                  <TableCell><ConsentBadge status={contact.email_opt_in_status} /></TableCell>
                  <TableCell className="text-muted-foreground">{contact.last_email_at ? dateFormat.format(new Date(contact.last_email_at)) : 'Never'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {pages > 1 && (
            <div className="flex items-center gap-3">
              <Button variant="outline" disabled={page <= 1} onClick={() => { setPage(page - 1); lastClicked.current = null; }}>Previous</Button>
              <span className="text-sm text-muted-foreground">Page {page} of {pages}</span>
              <Button variant="outline" disabled={page >= pages} onClick={() => { setPage(page + 1); lastClicked.current = null; }}>Next</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
