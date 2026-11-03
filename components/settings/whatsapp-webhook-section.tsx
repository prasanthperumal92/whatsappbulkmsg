'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchJson } from '@/lib/client/fetch-json';
import type { WhatsAppWebhookStatus } from '@/lib/whatsapp/webhook-status';
import { SecretField, type Credentials } from './secret-field';
import { CopyButton } from './webhook-section';

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** §5.2 S-01 Webhook setup card. Meta reports delivery and STOP replies to this link. */
export function WhatsAppWebhookSection() {
  const status = useQuery({ queryKey: ['whatsapp-webhook'], queryFn: () => fetchJson<WhatsAppWebhookStatus>('/api/settings/whatsapp-webhook'), refetchInterval: 15_000 });
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => fetchJson<Credentials>('/api/settings/credentials') });
  const data = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>WhatsApp webhook</h2>
        </CardTitle>
        <CardDescription>Meta uses this link to tell the app when a message is delivered or read, and to record people who reply STOP.</CardDescription>
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
              <Label htmlFor="settings-whatsapp-webhook-url">Callback URL</Label>
              <div className="flex gap-2">
                <Input id="settings-whatsapp-webhook-url" readOnly value={data.url} onFocus={(e) => e.target.select()} />
                <CopyButton text={data.url} label="Copy the callback URL" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="settings-whatsapp-verify-token">Verify token</Label>
              <div className="flex gap-2">
                <Input id="settings-whatsapp-verify-token" readOnly value={data.verify_token ?? 'APP_ENCRYPTION_KEY isn’t set'} onFocus={(e) => e.target.select()} />
                {data.verify_token && <CopyButton text={data.verify_token} label="Copy the verify token" />}
              </div>
            </div>
            {data.notice === 'localhost' && (
              <Alert>
                <AlertDescription>Meta can’t reach this computer, so this link won’t work from local dev. Register the link shown on your production site instead.</AlertDescription>
              </Alert>
            )}
            {data.notice === 'preview' && (
              <Alert>
                <AlertDescription>This is a preview deployment. Register the link shown on your production site instead.</AlertDescription>
              </Alert>
            )}
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Save your App Secret below first, from App settings → Basic in your Meta app.</li>
              <li>In your Meta app, open WhatsApp → Configuration, and paste the callback URL and verify token.</li>
              <li>
                Subscribe to these webhook fields:
                <code className="mt-1 block text-xs text-muted-foreground">{data.fields.join(', ')}</code>
              </li>
            </ol>
          </>
        )}

        <SecretField id="settings-meta-app-secret" label="App Secret" name="META_APP_SECRET" placeholder="App Secret" source={credentials.data?.META_APP_SECRET} />

        {data && (
          <p className="text-sm" role="status">
            {data.last_event_at ? <>Last event received {dateTime.format(new Date(data.last_event_at))}.</> : <span className="text-muted-foreground">No events received yet.</span>}
          </p>
        )}
        {data?.rejected_at && (
          <Alert variant="destructive">
            <AlertDescription>
              An event was refused on {dateTime.format(new Date(data.rejected_at))} because its signature didn’t match. {data.secret_set ? 'Check that the App Secret above belongs to this Meta app.' : 'Save the App Secret above.'}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
