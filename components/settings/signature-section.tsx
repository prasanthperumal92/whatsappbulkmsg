'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { fetchJson } from '@/lib/client/fetch-json';
import type { Settings } from '@/lib/settings/schema';

/** §5.2 S-01 Email → Footer, and the signature added above it. */
export function SignatureSection() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchJson<Settings>('/api/settings') });
  const [form, setForm] = useState<{ signature: string; postalAddress: string } | null>(null);
  useEffect(() => {
    if (settings.data && !form) setForm({ signature: settings.data.email.signature ?? '', postalAddress: settings.data.email.postalAddress ?? '' });
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (value: NonNullable<typeof form>) =>
      fetchJson<Settings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ email: { signature: value.signature.trim() || null, postalAddress: value.postalAddress.trim() || null } }),
      }),
    onSuccess: (next) => client.setQueryData(['settings'], next),
  });

  const change = (patch: Partial<NonNullable<typeof form>>) => {
    save.reset();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Signature and address</h2>
        </CardTitle>
        <CardDescription>Added to the end of every email, so you don&apos;t have to type them each time.</CardDescription>
      </CardHeader>
      <CardContent>
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
            <div className="grid gap-1.5">
              <Label htmlFor="settings-signature">Signature</Label>
              <Textarea
                id="settings-signature"
                rows={4}
                maxLength={2000}
                aria-describedby="settings-signature-hint"
                placeholder={'Regards,\nYour name\nYour company'}
                value={form.signature}
                onChange={(e) => change({ signature: e.target.value })}
              />
              <p id="settings-signature-hint" className="text-xs text-muted-foreground">
                Optional. Use *bold* for bold text and [our website](https://example.com) for a link.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="settings-address">Business address</Label>
              <Textarea
                id="settings-address"
                rows={3}
                maxLength={500}
                aria-describedby="settings-address-hint"
                value={form.postalAddress}
                onChange={(e) => change({ postalAddress: e.target.value })}
              />
              <p id="settings-address-hint" className="text-xs text-muted-foreground">
                Required before you can send. Marketing emails must show a postal address, so it appears in the footer beside the unsubscribe link.
              </p>
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
