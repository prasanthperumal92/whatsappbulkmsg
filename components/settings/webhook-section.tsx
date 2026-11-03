'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchJson } from '@/lib/client/fetch-json';
import type { EmailWebhookStatus } from '@/lib/email/webhook-status';
import { SecretField, type Credentials } from './secret-field';

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed'); // Not allowed by the browser: the text is on screen to copy by hand.
    }
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <Button type="button" variant="outline" aria-label={label} onClick={copy}>
      {state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span role="status">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy it by hand' : 'Copy'}</span>
    </Button>
  );
}

/** §5.2 S-01 Email → Webhook setup card. Resend reports delivery, opens, clicks, bounces and complaints to this link. */
export function WebhookSection() {
  const status = useQuery({ queryKey: ['email-webhook'], queryFn: () => fetchJson<EmailWebhookStatus>('/api/settings/email-webhook'), refetchInterval: 15_000 });
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => fetchJson<Credentials>('/api/settings/credentials') });
  const data = status.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Resend webhook</h2>
        </CardTitle>
        <CardDescription>Resend uses this link to tell the app when an email is delivered, opened, clicked or bounced, and to stop emailing addresses that bounce or complain.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.error ? (
          <Alert variant="destructive">
            <AlertDescription>{status.error.message}</AlertDescription>
          </Alert>
        ) : !data ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="settings-webhook-url">Webhook link</Label>
              <div className="flex gap-2">
                <Input id="settings-webhook-url" readOnly value={data.url} onFocus={(e) => e.target.select()} />
                <CopyButton text={data.url} label="Copy the webhook link" />
              </div>
            </div>
            {data.notice === 'localhost' && (
              <Alert>
                <AlertDescription>Resend can’t reach this computer, so this link won’t work from local dev. Register the link shown on your production site instead, or set APP_URL to a public address.</AlertDescription>
              </Alert>
            )}
            {data.notice === 'preview' && (
              <Alert>
                <AlertDescription>This is a preview deployment. Register the link shown on your production site instead.</AlertDescription>
              </Alert>
            )}

            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                In Resend, open{' '}
                <a className="underline underline-offset-2" href="https://resend.com/webhooks" target="_blank" rel="noreferrer">Webhooks</a>
                {' '}and add an endpoint with the link above.
              </li>
              <li>
                <span className="flex flex-wrap items-center gap-2">
                  Select these events:
                  <CopyButton text={data.events.join('\n')} label="Copy the event names" />
                </span>
                <code className="mt-1 block text-xs text-muted-foreground">{data.events.join(', ')}</code>
              </li>
              <li>Copy the endpoint’s signing secret from Resend, and save it below.</li>
            </ol>
          </>
        )}

        <SecretField id="settings-resend-webhook" label="Signing secret" name="RESEND_WEBHOOK_SECRET" placeholder="whsec_…" source={credentials.data?.RESEND_WEBHOOK_SECRET} />

        {data && (
          <p className="text-sm" role="status">
            {data.last_event_at ? (
              <>Last event received {dateTime.format(new Date(data.last_event_at))}{data.last_event_type && ` (${data.last_event_type})`}.</>
            ) : (
              <span className="text-muted-foreground">No events received yet.</span>
            )}
          </p>
        )}
        {data?.rejected_at && (
          <Alert variant="destructive">
            <AlertDescription>
              An event was refused on {dateTime.format(new Date(data.rejected_at))} because its signature didn’t match. {data.secret_set ? 'Check that the signing secret above is the one for this endpoint.' : 'Save the signing secret above.'}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
