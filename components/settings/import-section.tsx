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

type ImportSettings = Settings['import'];

const CONSENT = [['unknown', 'Unknown'], ['opted_in', 'Opted in'], ['opted_out', 'Opted out']] as const;

/** §5.2 S-01 Import. */
export function ImportSection() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchJson<Settings>('/api/settings') });
  const [form, setForm] = useState<ImportSettings | null>(null);
  useEffect(() => {
    if (settings.data && !form) setForm(settings.data.import);
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (value: ImportSettings) => fetchJson<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify({ import: value }) }),
    onSuccess: (next) => {
      client.setQueryData(['settings'], next);
      setForm(next.import);
    },
  });

  const change = (patch: Partial<ImportSettings>) => {
    save.reset();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Import</h2>
        </CardTitle>
        <CardDescription>Starting values for each import. They can be changed for a single file in the wizard.</CardDescription>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="settings-country">Default country (ISO code)</Label>
                <Input id="settings-country" maxLength={2} value={form.defaultCountry} onChange={(e) => change({ defaultCountry: e.target.value.toUpperCase() })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-zone">Fallback time zone</Label>
                <Input id="settings-zone" value={form.fallbackTimeZone} onChange={(e) => change({ fallbackTimeZone: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-whatsapp">Default WhatsApp opt-in</Label>
                <select id="settings-whatsapp" className={selectClass} value={form.defaultWhatsappOptIn} onChange={(e) => change({ defaultWhatsappOptIn: e.target.value as ImportSettings['defaultWhatsappOptIn'] })}>
                  {CONSENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-email">Default email opt-in</Label>
                <select id="settings-email" className={selectClass} value={form.defaultEmailOptIn} onChange={(e) => change({ defaultEmailOptIn: e.target.value as ImportSettings['defaultEmailOptIn'] })}>
                  {CONSENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-policy">Existing-contact policy</Label>
                <select id="settings-policy" className={selectClass} value={form.existingContactPolicy} onChange={(e) => change({ existingContactPolicy: e.target.value as ImportSettings['existingContactPolicy'] })}>
                  <option value="fill_empty">Fill empty fields only</option>
                  <option value="skip">Skip</option>
                  <option value="overwrite">Overwrite mapped fields</option>
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="settings-size">Max file size (MB)</Label>
                <Input id="settings-size" type="number" min={1} value={form.maxFileSizeMb} onChange={(e) => change({ maxFileSizeMb: Number(e.target.value) })} />
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
