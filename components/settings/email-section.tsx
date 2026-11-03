'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchJson } from '@/lib/client/fetch-json';
import type { Settings } from '@/lib/settings/schema';
import { SecretField, type Credentials } from './secret-field';

type Form = { fromName: string; fromAddress: string; replyTo: string; dailyCap: number; monthlyCap: number; frequencyCapDays: number };

/** §5.2 S-01 Email: the parts needed to send. Domain status comes with T8.1. */
export function EmailSection() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchJson<Settings>('/api/settings') });
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => fetchJson<Credentials>('/api/settings/credentials') });
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (!settings.data || form) return;
    const { email, emailSending } = settings.data;
    setForm({ fromName: email.fromName ?? '', fromAddress: email.fromAddress ?? '', replyTo: email.replyTo ?? '', dailyCap: emailSending.dailyCap, monthlyCap: emailSending.monthlyCap, frequencyCapDays: emailSending.frequencyCapDays });
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: ({ fromName, fromAddress, replyTo, ...sending }: Form) =>
      fetchJson<Settings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ email: { fromName: fromName.trim() || null, fromAddress: fromAddress.trim() || null, replyTo: replyTo.trim() || null }, emailSending: sending }),
      }),
    onSuccess: (next) => client.setQueryData(['settings'], next),
  });

  const change = (patch: Partial<Form>) => {
    save.reset();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Email</h2>
        </CardTitle>
        <CardDescription>Your Resend connection, and who your emails come from.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SecretField id="settings-resend-key" label="Resend API key" name="RESEND_API_KEY" placeholder="re_…" source={credentials.data?.RESEND_API_KEY} />
        {!form ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(form);
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="settings-from-name">From name</Label>
                <Input id="settings-from-name" placeholder="Your company" value={form.fromName} onChange={(e) => change({ fromName: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-from-address">From address</Label>
                <Input id="settings-from-address" type="email" placeholder="offers@mail.example.com" aria-describedby="settings-from-hint" value={form.fromAddress} onChange={(e) => change({ fromAddress: e.target.value })} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="settings-reply-to">Reply-to address</Label>
                <Input id="settings-reply-to" type="email" placeholder="Optional" value={form.replyTo} onChange={(e) => change({ replyTo: e.target.value })} />
              </div>
              <p id="settings-from-hint" className="text-xs text-muted-foreground sm:col-span-2">The from address must be on a domain verified in Resend.</p>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-daily-cap">Daily send cap</Label>
                <Input id="settings-daily-cap" type="number" min={1} value={form.dailyCap} onChange={(e) => change({ dailyCap: Number(e.target.value) })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-monthly-cap">Monthly send cap</Label>
                <Input id="settings-monthly-cap" type="number" min={1} value={form.monthlyCap} onChange={(e) => change({ monthlyCap: Number(e.target.value) })} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="settings-frequency">Skip contacts emailed in the last (days)</Label>
                <Input id="settings-frequency" type="number" min={0} aria-describedby="settings-frequency-hint" value={form.frequencyCapDays} onChange={(e) => change({ frequencyCapDays: Number(e.target.value) })} />
                <p id="settings-frequency-hint" className="text-xs text-muted-foreground">Use 0 to turn this off.</p>
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
