'use client';

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { selectClass } from '@/components/imports/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchJson } from '@/lib/client/fetch-json';
import type { Selection } from '@/lib/email/audience';
import type { SendSummary } from '@/lib/email/send';
import { UNKNOWN_ACK } from '@/lib/email/shared';
import type { Settings } from '@/lib/settings/schema';
import type { WhatsAppExclusion } from '@/lib/whatsapp/audience';
import type { WhatsAppPreview } from '@/lib/whatsapp/preview';
import { VARIABLE_FIELDS } from '@/lib/whatsapp/shared';
import type { VariableSlot } from '@/lib/whatsapp/template-shape';
import type { TemplateView } from '@/lib/whatsapp/templates';

const EXCLUSION_TEXT: Record<WhatsAppExclusion, string> = {
  deleted: 'deleted',
  no_phone: 'no phone number',
  suppressed: 'on the WhatsApp suppression list',
  opted_out: 'opted out',
  restricted_country: 'in a country WhatsApp doesn’t deliver marketing messages to',
  unknown_consent: 'consent unknown',
  frequency_cap: 'messaged recently',
  empty_variable: 'a variable has no value for them',
};

const FIELD_LABEL: Record<(typeof VARIABLE_FIELDS)[number], string> = { first_name: 'First name', last_name: 'Last name', display_name: 'Display name', company: 'Company', city: 'City', email: 'Email' };

type SlotValue = { source: string; text: string; fallback: string };

/** A variable named like a contact field fills itself in. A missing first name reads naturally as "there". */
function initialValue(slot: VariableSlot): SlotValue {
  const name = slot.key.toLowerCase();
  if ((VARIABLE_FIELDS as readonly string[]).includes(name)) return { source: name, text: '', fallback: name === 'first_name' ? 'there' : '' };
  return { source: 'static', text: '', fallback: '' };
}

function toMapping(slots: VariableSlot[], values: Record<string, SlotValue>) {
  const mapping: Record<string, unknown> = {};
  for (const slot of slots) {
    const value = values[slot.key] ?? initialValue(slot);
    const link = value.text.trim();
    const fallback = value.fallback.trim() ? { fallback: value.fallback.trim() } : {};
    if (slot.kind === 'media') {
      if (link.startsWith('https://')) mapping[slot.key] = { media_link: link };
    } else {
      mapping[slot.key] = value.source === 'static' ? { static: value.text, ...fallback } : { field: value.source, ...fallback };
    }
  }
  return mapping;
}

export function WhatsAppCompose({ selection, selectedCount, onCancel, onSent }: { selection: Selection; selectedCount: number; onCancel: () => void; onSent: (summary: SendSummary) => void }) {
  const templates = useQuery({ queryKey: ['whatsapp-templates'], queryFn: () => fetchJson<{ items: TemplateView[] }>('/api/whatsapp/templates') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchJson<Settings>('/api/settings') });
  const usable = useMemo(() => (templates.data?.items ?? []).filter((t) => t.status === 'APPROVED' && !t.unsupported), [templates.data]);
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<Record<string, SlotValue>>({});
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [ack, setAck] = useState('');
  const [testPhone, setTestPhone] = useState<string | null>(null);
  const template = usable.find((t) => t.id === templateId);
  const mapping = useMemo(() => toMapping(template?.slots ?? [], values), [template, values]);

  // Typing in a variable shouldn't send a request, and an audit row, per keystroke.
  const [settled, setSettled] = useState(mapping);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(mapping), 400);
    return () => clearTimeout(timer);
  }, [mapping]);

  const preview = useQuery({
    queryKey: ['whatsapp-preview', selection, includeUnknown, templateId, settled],
    queryFn: () => fetchJson<WhatsAppPreview>('/api/whatsapp/preview', { method: 'POST', body: JSON.stringify({ selection, include_unknown: includeUnknown, template_id: templateId || undefined, mapping: settled }) }),
    placeholderData: keepPreviousData,
  });
  const recipients = preview.data?.recipients ?? 0;
  const problems = preview.data?.problems ?? [];
  const send = useMutation({
    mutationFn: () => fetchJson<SendSummary>('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ selection, include_unknown: includeUnknown, unknown_ack: includeUnknown ? ack : undefined, template_id: templateId, mapping, expected_recipients: recipients }) }),
    onSuccess: onSent,
    onError: () => void preview.refetch(),
  });
  const phone = testPhone ?? settings.data?.whatsappSending.testPhones[0] ?? '';
  const test = useMutation({ mutationFn: () => fetchJson<{ to: string; provider: string }>('/api/whatsapp/test', { method: 'POST', body: JSON.stringify({ template_id: templateId, mapping, to: phone }) }) });

  const ackMissing = includeUnknown && ack !== UNKNOWN_ACK;
  const settling = settled !== mapping || preview.isFetching;
  const canSend = Boolean(template) && recipients > 0 && problems.length === 0 && !ackMissing && !send.isPending && !settling;
  const exclusions = preview.data ? (Object.entries(preview.data.excluded) as [WhatsAppExclusion, number][]).filter(([, n]) => n > 0) : [];
  const unknownExcluded = preview.data?.excluded.unknown_consent ?? 0;
  const setSlot = (slot: VariableSlot, patch: Partial<SlotValue>) => setValues((v) => ({ ...v, [slot.key]: { ...(v[slot.key] ?? initialValue(slot)), ...patch } }));

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>
          <h2>WhatsApp {selectedCount.toLocaleString('en-IN')} selected {selectedCount === 1 ? 'contact' : 'contacts'}</h2>
        </CardTitle>
        <CardDescription>WhatsApp only lets businesses start a conversation with a template Meta has approved, so choose one and fill in its variables.</CardDescription>
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
            <Label htmlFor="whatsapp-template">Template</Label>
            {templates.isPending ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <select id="whatsapp-template" className={selectClass} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setValues({}); test.reset(); }}>
                <option value="">Choose a template…</option>
                {usable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language}, {t.category?.toLowerCase() ?? 'uncategorised'})</option>)}
              </select>
            )}
            {templates.data && usable.length === 0 && (
              <p className="text-xs text-muted-foreground">No approved templates yet. <Link className="underline underline-offset-2" href="/templates">Sync them from Meta on the Templates page</Link>.</p>
            )}
          </div>

          {template && template.slots.length > 0 && (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Variables</legend>
              {template.slots.map((slot) => {
                const value = values[slot.key] ?? initialValue(slot);
                const id = `whatsapp-slot-${slot.key}`;
                if (slot.kind === 'media') {
                  return (
                    <div key={slot.key} className="grid gap-1.5">
                      <Label htmlFor={id}>{slot.label}</Label>
                      <Input id={id} type="url" placeholder="https://…" value={value.text} onChange={(e) => setSlot(slot, { text: e.target.value })} />
                      <p className="text-xs text-muted-foreground">A public https link. Meta fetches the file from it for every recipient.</p>
                    </div>
                  );
                }
                return (
                  <div key={slot.key} className="grid gap-2 sm:grid-cols-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor={id}>{slot.label}</Label>
                      <select id={id} className={selectClass} value={value.source} onChange={(e) => setSlot(slot, { source: e.target.value })}>
                        {VARIABLE_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
                        <option value="static">Same text for everyone</option>
                      </select>
                    </div>
                    {value.source === 'static' ? (
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label htmlFor={`${id}-text`}>Text for {slot.label}</Label>
                        <Input id={`${id}-text`} maxLength={1024} value={value.text} onChange={(e) => setSlot(slot, { text: e.target.value })} />
                      </div>
                    ) : (
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label htmlFor={`${id}-fallback`}>If empty, use</Label>
                        <Input id={`${id}-fallback`} maxLength={1024} placeholder="Leave blank to skip that contact" value={value.fallback} onChange={(e) => setSlot(slot, { fallback: e.target.value })} />
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}

          {template && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Preview</p>
              {template.header_text && <p className="font-medium">{template.header_text}</p>}
              <p className="whitespace-pre-wrap">{preview.data?.sample ?? template.body}</p>
              {template.footer && <p className="mt-1 text-xs text-muted-foreground">{template.footer}</p>}
              {template.buttons.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Buttons: {template.buttons.join(' · ')}</p>}
            </div>
          )}

          <div className="rounded-lg border p-3 text-sm" aria-live="polite">
            {preview.error ? (
              <p className="text-destructive">{preview.error.message}</p>
            ) : !preview.data ? (
              <Skeleton className="h-5 w-48" />
            ) : (
              <>
                <p className="font-medium">
                  {recipients.toLocaleString('en-IN')} {recipients === 1 ? 'person' : 'people'} will get this message
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
                  <Label htmlFor="whatsapp-ack">Type {UNKNOWN_ACK} to confirm you have a lawful reason to message them</Label>
                  <Input id="whatsapp-ack" className="max-w-40" autoComplete="off" value={ack} onChange={(e) => setAck(e.target.value)} />
                </div>
              )}
            </fieldset>
          )}

          {problems.filter((p) => p !== 'Choose a template.').map((problem) => (
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

          {template && (
            <div className="grid gap-1.5">
              <Label htmlFor="whatsapp-test-phone">Test number</Label>
              <div className="flex gap-2">
                <Input id="whatsapp-test-phone" placeholder="+91 98765 43210" value={phone} onChange={(e) => setTestPhone(e.target.value)} />
                <Button type="button" variant="outline" disabled={!phone.trim() || test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Sending test…' : 'Send test'}</Button>
              </div>
              {test.isSuccess && (
                <p className="text-sm text-muted-foreground" role="status">
                  {test.data.provider === 'mock' ? `Test simulated for ${test.data.to}. Mock mode sends nothing.` : `Test sent to ${test.data.to}.`}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!canSend}>
              {send.isPending ? 'Sending…' : `Send to ${recipients.toLocaleString('en-IN')} ${recipients === 1 ? 'person' : 'people'}`}
            </Button>
            <Button type="button" variant="ghost" disabled={send.isPending} onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
