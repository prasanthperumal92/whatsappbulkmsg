'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchJson } from '@/lib/client/fetch-json';
import type { ContactRow } from '@/lib/contacts/store';

const EMPTY = { phone: '', email: '', first_name: '', last_name: '', company: '', city: '', country: '', tags: '', consent_proof_ref: '' };
type TextField = keyof typeof EMPTY;

const FIELDS: { name: TextField; label: string; type?: string; placeholder?: string; hint?: string; wide?: boolean }[] = [
  { name: 'phone', label: 'Phone', type: 'tel', placeholder: '+91 98765 43210' },
  { name: 'email', label: 'Email', type: 'email', placeholder: 'name@company.com' },
  { name: 'first_name', label: 'First name' },
  { name: 'last_name', label: 'Last name' },
  { name: 'company', label: 'Company' },
  { name: 'city', label: 'City' },
  { name: 'country', label: 'Country', placeholder: 'India or IN', hint: 'Optional. Without it, the country comes from the phone number.' },
  { name: 'tags', label: 'Tags', placeholder: 'steel, expo', hint: 'Separate tags with commas.' },
  { name: 'consent_proof_ref', label: 'Consent proof reference', hint: 'Where the proof kept outside this app can be found, such as a form ID or file name.', wide: true },
];

function addedMessage(c: ContactRow) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.phone_e164 || c.email;
  const blocked = [c.opt_in_status === 'opted_out' && 'WhatsApp', c.email_opt_in_status === 'opted_out' && 'email'].filter(Boolean);
  return blocked.length
    ? `Added ${name}. They are on the ${blocked.join(' and ')} suppression list, so they are marked as opted out.`
    : `Added ${name}.`;
}

export function AddContact() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(EMPTY);
  const [whatsappConsent, setWhatsappConsent] = useState(false);
  const [emailConsent, setEmailConsent] = useState(false);
  const hasPhone = values.phone.trim() !== '';
  const hasEmail = values.email.trim() !== '';

  const add = useMutation({
    mutationFn: () =>
      fetchJson<ContactRow>('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          whatsapp_consent_confirmed: whatsappConsent && hasPhone,
          email_consent_confirmed: emailConsent && hasEmail,
        }),
      }),
    onSuccess: () => {
      setValues(EMPTY);
      setWhatsappConsent(false);
      setEmailConsent(false);
      setOpen(false);
      router.refresh();
    },
  });

  return (
    <div className="mb-6 space-y-4">
      {add.isSuccess && !open && (
        <Alert>
          <AlertDescription>{addedMessage(add.data)}</AlertDescription>
        </Alert>
      )}

      {!open ? (
        <Button onClick={() => setOpen(true)}>Add contact</Button>
      ) : (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>
              <h2>Add contact</h2>
            </CardTitle>
            <CardDescription>A contact needs a phone number or an email address. Everything else is optional.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                add.mutate();
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {FIELDS.map((f) => (
                  <div key={f.name} className={f.wide ? 'grid gap-1.5 sm:col-span-2' : 'grid content-start gap-1.5'}>
                    <Label htmlFor={`contact-${f.name}`}>{f.label}</Label>
                    <Input
                      id={`contact-${f.name}`}
                      type={f.type ?? 'text'}
                      placeholder={f.placeholder}
                      aria-describedby={f.hint ? `contact-${f.name}-hint` : undefined}
                      value={values[f.name]}
                      onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                    />
                    {f.hint && (
                      <p id={`contact-${f.name}-hint`} className="text-xs text-muted-foreground">
                        {f.hint}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Consent</legend>
                <p className="text-xs text-muted-foreground">Leave these unticked if you aren&apos;t sure. The contact&apos;s consent is then recorded as unknown.</p>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 size-4" disabled={!hasPhone} checked={whatsappConsent && hasPhone} onChange={(e) => setWhatsappConsent(e.target.checked)} />
                  I confirm this contact agreed to receive WhatsApp marketing messages from us, and the proof is kept on file.
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 size-4" disabled={!hasEmail} checked={emailConsent && hasEmail} onChange={(e) => setEmailConsent(e.target.checked)} />
                  I confirm this contact agreed to receive marketing emails from us, and the proof is kept on file.
                </label>
              </fieldset>

              {add.error && (
                <Alert variant="destructive">
                  <AlertDescription>{add.error.message}</AlertDescription>
                </Alert>
              )}

              <div className="flex gap-2">
                <Button type="submit" disabled={add.isPending}>
                  {add.isPending ? 'Adding…' : 'Add contact'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    add.reset();
                    setOpen(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
