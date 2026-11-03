'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { fetchJson } from '@/lib/client/fetch-json';
import type { Exclusion, Selection } from '@/lib/email/audience';
import type { EmailPreview } from '@/lib/email/preview';
import type { SendSummary } from '@/lib/email/send';
import { COMPOSE_VARIABLES, UNKNOWN_ACK } from '@/lib/email/shared';

const EXCLUSION_TEXT: Record<Exclusion, string> = {
  deleted: 'deleted',
  no_email: 'no email address',
  suppressed: 'on the email suppression list',
  opted_out: 'opted out',
  unknown_consent: 'consent unknown',
  frequency_cap: 'emailed recently',
  duplicate_address: 'same address as another contact',
};

export function EmailCompose({ selection, selectedCount, onCancel, onSent }: { selection: Selection; selectedCount: number; onCancel: () => void; onSent: (summary: SendSummary) => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [ack, setAck] = useState('');

  const preview = useQuery({
    queryKey: ['email-preview', selection, includeUnknown],
    queryFn: () => fetchJson<EmailPreview>('/api/emails/preview', { method: 'POST', body: JSON.stringify({ selection, include_unknown: includeUnknown }) }),
  });
  const recipients = preview.data?.recipients ?? 0;
  const problems = preview.data?.problems ?? [];

  const send = useMutation({
    mutationFn: () =>
      fetchJson<SendSummary>('/api/emails/send', {
        method: 'POST',
        body: JSON.stringify({ selection, include_unknown: includeUnknown, unknown_ack: includeUnknown ? ack : undefined, subject, body, expected_recipients: recipients }),
      }),
    onSuccess: onSent,
    onError: () => void preview.refetch(),
  });
  const test = useMutation({
    mutationFn: () => fetchJson<{ to: string; provider: string }>('/api/emails/test', { method: 'POST', body: JSON.stringify({ subject, body }) }),
  });

  const hasContent = subject.trim() !== '' && body.trim() !== '';
  const ackMissing = includeUnknown && ack !== UNKNOWN_ACK;
  const canSend = hasContent && recipients > 0 && problems.length === 0 && !ackMissing && !send.isPending && !preview.isFetching;
  const exclusions = preview.data ? (Object.entries(preview.data.excluded) as [Exclusion, number][]).filter(([, n]) => n > 0) : [];
  const unknownExcluded = preview.data?.excluded.unknown_consent ?? 0;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>
          <h2>Email {selectedCount.toLocaleString('en-IN')} selected {selectedCount === 1 ? 'contact' : 'contacts'}</h2>
        </CardTitle>
        <CardDescription>
          Each person gets their own copy, with your <Link className="underline underline-offset-2" href="/settings">signature and address</Link> and an unsubscribe link added at the end.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) send.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="email-subject">Subject</Label>
            <Input id="email-subject" maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="email-body">Message</Label>
            <Textarea id="email-body" rows={8} aria-describedby="email-body-hint" value={body} onChange={(e) => setBody(e.target.value)} />
            <p id="email-body-hint" className="text-xs text-muted-foreground">
              Personalise with {COMPOSE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}. A missing first name becomes &quot;there&quot;. Contacts missing any other value you use are skipped.
            </p>
          </div>

          <div className="rounded-lg border p-3 text-sm" aria-live="polite">
            {preview.error ? (
              <p className="text-destructive">{preview.error.message}</p>
            ) : !preview.data ? (
              <Skeleton className="h-5 w-48" />
            ) : (
              <>
                <p className="font-medium">
                  {recipients.toLocaleString('en-IN')} {recipients === 1 ? 'person' : 'people'} will get this email
                  {preview.data.provider === 'mock' && ' (simulated: mock mode sends nothing)'}
                </p>
                {exclusions.length > 0 && (
                  <ul className="mt-1 text-muted-foreground">
                    {exclusions.map(([reason, n]) => <li key={reason}>{n.toLocaleString('en-IN')} left out: {EXCLUSION_TEXT[reason]}</li>)}
                  </ul>
                )}
              </>
            )}
          </div>

          {(includeUnknown || unknownExcluded > 0) && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Contacts with unknown consent</legend>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={includeUnknown} onChange={(e) => { setIncludeUnknown(e.target.checked); setAck(''); }} />
                Include contacts whose consent is unknown. Contacts in strict-consent countries, or with no known country, stay left out.
              </label>
              {includeUnknown && (
                <div className="grid gap-1.5">
                  <Label htmlFor="email-ack">Type {UNKNOWN_ACK} to confirm you have a lawful reason to email them</Label>
                  <Input id="email-ack" className="max-w-40" autoComplete="off" value={ack} onChange={(e) => setAck(e.target.value)} />
                </div>
              )}
            </fieldset>
          )}

          {problems.map((problem) => (
            <Alert key={problem} variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ))}
          {preview.data?.warnings.map((warning) => (
            <Alert key={warning}>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}
          {(send.error || test.error) && (
            <Alert variant="destructive">
              <AlertDescription>{(send.error ?? test.error)!.message}</AlertDescription>
            </Alert>
          )}
          {test.isSuccess && (
            <p className="text-sm text-muted-foreground" role="status">
              {test.data.provider === 'mock' ? `Test simulated for ${test.data.to}. Mock mode sends nothing.` : `Test email sent to ${test.data.to}.`}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!canSend}>
              {send.isPending ? 'Sending…' : `Send to ${recipients.toLocaleString('en-IN')} ${recipients === 1 ? 'person' : 'people'}`}
            </Button>
            <Button type="button" variant="outline" disabled={!hasContent || test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? 'Sending test…' : 'Send test to me'}
            </Button>
            <Button type="button" variant="ghost" disabled={send.isPending} onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
