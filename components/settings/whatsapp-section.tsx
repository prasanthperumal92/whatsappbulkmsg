'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { selectClass } from '@/components/imports/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchJson } from '@/lib/client/fetch-json';
import type { Settings } from '@/lib/settings/schema';
import type { AppStatus } from '@/lib/status';
import type { ConnectionInfo } from '@/lib/whatsapp/provider';
import { SecretField, type Credentials } from './secret-field';

type Form = { provider: 'graph' | 'mock'; graphApiVersion: string; messagesPerSecond: number; frequencyCapDays: number; testPhone: string };

/** §5.2 S-01 WhatsApp connection and sending. */
export function WhatsAppSection() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchJson<Settings>('/api/settings') });
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => fetchJson<Credentials>('/api/settings/credentials') });
  const status = useQuery({ queryKey: ['status'], queryFn: () => fetchJson<AppStatus>('/api/status') });
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (!settings.data || form) return;
    const { whatsapp, whatsappSending } = settings.data;
    setForm({ provider: whatsapp.provider, graphApiVersion: whatsapp.graphApiVersion, messagesPerSecond: whatsappSending.messagesPerSecond, frequencyCapDays: whatsappSending.frequencyCapDays, testPhone: whatsappSending.testPhones[0] ?? '' });
  }, [settings.data, form]);

  const isLocal = status.data?.environment === 'local';
  const save = useMutation({
    mutationFn: ({ provider, graphApiVersion, testPhone, ...sending }: Form) =>
      fetchJson<Settings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ whatsapp: { graphApiVersion, ...(isLocal && { provider }) }, whatsappSending: { ...sending, testPhones: testPhone.trim() ? [testPhone.trim()] : [] } }),
      }),
    onSuccess: (next) => {
      client.setQueryData(['settings'], next);
      void client.invalidateQueries({ queryKey: ['status'] });
    },
  });
  const test = useMutation({ mutationFn: () => fetchJson<ConnectionInfo & { provider: string }>('/api/whatsapp/connection', { method: 'POST' }) });

  const change = (patch: Partial<Form>) => {
    save.reset();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };
  const c = credentials.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>WhatsApp</h2>
        </CardTitle>
        <CardDescription>
          Your connection to Meta’s WhatsApp Business API. Copy these from{' '}
          <a className="underline underline-offset-2" href="https://business.facebook.com/settings/system-users" target="_blank" rel="noreferrer">Meta Business Manager</a> and{' '}
          <a className="underline underline-offset-2" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">your Meta app’s API setup</a>. They’re stored encrypted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <SecretField id="settings-whatsapp-token" label="Access token" name="WHATSAPP_ACCESS_TOKEN" placeholder="EAAG…" source={c?.WHATSAPP_ACCESS_TOKEN} hint="Use a System User token. Temporary tokens stop working after about a day." />
          <SecretField id="settings-whatsapp-waba" label="WhatsApp Business Account ID" name="WHATSAPP_WABA_ID" placeholder="1234567890" source={c?.WHATSAPP_WABA_ID} plain />
          <SecretField id="settings-whatsapp-phone" label="Phone number ID" name="WHATSAPP_PHONE_NUMBER_ID" placeholder="1234567890" source={c?.WHATSAPP_PHONE_NUMBER_ID} plain hint="This is Meta’s ID for the number, not the phone number itself." />
        </div>

        <div className="space-y-2">
          <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          {test.error && (
            <Alert variant="destructive">
              <AlertDescription>{test.error.message}</AlertDescription>
            </Alert>
          )}
          {test.data && (
            <p className="text-sm" role="status">
              Connected{test.data.provider === 'mock' && ' to Mock, which sends nothing'}: {test.data.verified_name ?? 'unnamed'} ({test.data.display_phone_number ?? 'no number'}). Quality {test.data.quality_rating ?? 'unknown'}, messaging limit {test.data.messaging_limit ?? 'unknown'}.
            </p>
          )}
        </div>

        {!form ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(form);
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {isLocal && (
                <div className="grid gap-1.5">
                  <Label htmlFor="settings-whatsapp-provider">Provider on local dev</Label>
                  <select id="settings-whatsapp-provider" className={selectClass} value={form.provider} onChange={(e) => change({ provider: e.target.value as Form['provider'] })}>
                    <option value="mock">Mock (sends nothing)</option>
                    <option value="graph">Graph API (sends real messages)</option>
                  </select>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="settings-whatsapp-version">Graph API version</Label>
                <Input id="settings-whatsapp-version" placeholder="v26.0" value={form.graphApiVersion} onChange={(e) => change({ graphApiVersion: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-whatsapp-rate">Messages per second</Label>
                <Input id="settings-whatsapp-rate" type="number" min={1} max={80} value={form.messagesPerSecond} onChange={(e) => change({ messagesPerSecond: Number(e.target.value) })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-whatsapp-frequency">Skip contacts messaged in the last (days)</Label>
                <Input id="settings-whatsapp-frequency" type="number" min={0} value={form.frequencyCapDays} onChange={(e) => change({ frequencyCapDays: Number(e.target.value) })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-whatsapp-test-phone">Test number</Label>
                <Input id="settings-whatsapp-test-phone" placeholder="+91 98765 43210" value={form.testPhone} onChange={(e) => change({ testPhone: e.target.value })} />
              </div>
            </div>
            {save.error && (
              <Alert variant="destructive">
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
              {save.isSuccess && <span className="text-sm text-muted-foreground" role="status">Saved</span>}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
