'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { actionLabel } from '@/lib/audit/labels';
import { fetchJson } from '@/lib/client/fetch-json';

type AuditRow = {
  id: string;
  at: string;
  userId: string;
  userEmail: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  detailsJson: Record<string, unknown>;
};
type AuditResponse = { items: AuditRow[]; total: number; page: number; page_size: number; facets: { users: string[]; actions: string[] } };

const ALL = '__all';
const CHANNEL_LABELS: Record<string, string> = { whatsapp: 'WhatsApp', email: 'Email', both: 'Both' };
const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A date input means the whole of that day, in the viewer's time zone. */
function dayBoundary(day: string, addDays = 0) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + addDays);
  return d.toISOString();
}

function describe(row: AuditRow) {
  const { channel: _channel, ...details } = row.detailsJson;
  const text = Object.entries(details)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
  return [row.entityId, text].filter(Boolean).join(' · ') || '—';
}

function FilterSelect(props: { id: string; label: string; all: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger id={props.id} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{props.all}</SelectItem>
          {props.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ActivityLog() {
  const [user, setUser] = useState(ALL);
  const [channel, setChannel] = useState(ALL);
  const [action, setAction] = useState(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page) });
  if (user !== ALL) params.set('user', user);
  if (channel !== ALL) params.set('channel', channel);
  if (action !== ALL) params.set('action', action);
  if (from) params.set('from', dayBoundary(from));
  if (to) params.set('to', dayBoundary(to, 1));

  const { data, error, isPending } = useQuery({
    queryKey: ['audit', params.toString()],
    queryFn: () => fetchJson<AuditResponse>(`/api/audit?${params}`),
    placeholderData: keepPreviousData,
  });

  const changing = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect id="f-user" label="Person" all="Everyone" value={user} onChange={changing(setUser)} options={(data?.facets.users ?? []).map((u) => ({ value: u, label: u }))} />
        <FilterSelect
          id="f-channel"
          label="Channel"
          all="All"
          value={channel}
          onChange={changing(setChannel)}
          options={[
            { value: 'whatsapp', label: 'WhatsApp' },
            { value: 'email', label: 'Email' },
          ]}
        />
        <FilterSelect id="f-action" label="Action" all="All actions" value={action} onChange={changing(setAction)} options={(data?.facets.actions ?? []).map((a) => ({ value: a, label: actionLabel(a) }))} />
        <div className="grid gap-1.5">
          <Label htmlFor="f-from">From</Label>
          <Input id="f-from" type="date" className="w-40" value={from} onChange={(e) => changing(setFrom)(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="f-to">To</Label>
          <Input id="f-to" type="date" className="w-40" value={to} onChange={(e) => changing(setTo)(e.target.value)} />
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.length ? (
                data.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">{dateTime.format(new Date(row.at))}</TableCell>
                    <TableCell>{row.userEmail ?? <span className="font-mono text-xs">{row.userId}</span>}</TableCell>
                    <TableCell>{CHANNEL_LABELS[String(row.detailsJson.channel)] ?? '—'}</TableCell>
                    <TableCell>{actionLabel(row.action)}</TableCell>
                    <TableCell className="max-w-md truncate" title={describe(row)}>
                      {describe(row)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No activity matches these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
