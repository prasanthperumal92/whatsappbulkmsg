'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchJson } from '@/lib/client/fetch-json';

export type CredentialSource = 'local_bin' | 'env' | 'settings' | 'none';
export type Credentials = Record<'WHATSAPP_ACCESS_TOKEN' | 'WHATSAPP_WABA_ID' | 'WHATSAPP_PHONE_NUMBER_ID' | 'META_APP_SECRET' | 'RESEND_API_KEY' | 'RESEND_WEBHOOK_SECRET', CredentialSource>;

const SOURCE_TEXT: Record<CredentialSource, string> = {
  local_bin: 'Loaded from .local.bin',
  env: 'Set by env var',
  settings: 'Saved in Settings',
  none: 'Not set',
};

/** Write-only: the value is never read back, only where it came from. */
export function SecretField({ id, label, name, placeholder, source, hint, plain = false }: { id: string; label: string; name: keyof Credentials; placeholder: string; source?: CredentialSource; hint?: string; /** An ID rather than a secret, so it's readable while being typed. */ plain?: boolean }) {
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => fetchJson<Credentials>('/api/settings/credentials', { method: 'PUT', body: JSON.stringify({ [name]: value }) }),
    onSuccess: (next) => {
      setValue('');
      client.setQueryData(['credentials'], next);
      void client.invalidateQueries({ queryKey: ['status'] });
      void client.invalidateQueries({ queryKey: ['email-webhook'] });
      void client.invalidateQueries({ queryKey: ['whatsapp-webhook'] });
    },
  });
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} type={plain ? 'text' : 'password'} autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" variant="outline" disabled={!value.trim() || save.isPending}>Save</Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {source ? SOURCE_TEXT[source] : 'Checking…'}
        {source && source !== 'none' && ' · It can’t be shown again.'}
        {hint && ` · ${hint}`}
      </p>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
