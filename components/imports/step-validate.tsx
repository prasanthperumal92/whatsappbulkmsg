'use client';

import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchJson } from '@/lib/client/fetch-json';
import { formatCount, type Policy, type ValidateSummary } from './types';

const POLICIES: [Policy, string][] = [
  ['fill_empty', 'Fill empty fields only'],
  ['skip', 'Skip'],
  ['overwrite', 'Overwrite mapped fields'],
];

const listCounts = (counts: Record<string, number>) => Object.entries(counts).map(([k, v]) => `${k} ${formatCount(v)}`).join(', ');

type Props = {
  importId: string;
  summary: ValidateSummary;
  policy: Policy;
  otherImportBy: string | null;
  busy: boolean;
  error: string | null;
  onPolicy: (policy: Policy) => void;
  onBack: () => void;
  onCommit: (consent: { consent_confirmed: boolean; email_consent_confirmed: boolean }) => void;
};

export function StepValidate({ importId, summary, policy, otherImportBy, busy, error, onPolicy, onBack, onCommit }: Props) {
  const [whatsappConsent, setWhatsappConsent] = useState(false);
  const [emailConsent, setEmailConsent] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const needsWhatsapp = summary.would_opt_in > 0;
  const needsEmail = summary.would_email_opt_in > 0;
  const importable = summary.valid_new + summary.valid_existing;
  const consented = (!needsWhatsapp || whatsappConsent) && (!needsEmail || emailConsent);

  const emailWarnings = summary.email_warnings.INVALID_EMAIL + summary.email_warnings.role;
  const invalid = Object.values(summary.invalid).reduce((a, b) => a + b, 0);
  const metrics: [string, number, string?][] = [
    ['Total rows', summary.total],
    ['Valid new', summary.valid_new],
    ['Valid, already in store', summary.valid_existing, 'Handled by the policy below'],
    ['Email-only (no usable phone)', summary.email_only, summary.email_only_unusable_phone ? `${formatCount(summary.email_only_unusable_phone)} had an unusable phone` : undefined],
    ['Duplicates within file', summary.duplicates_in_file, 'First occurrence kept'],
    ['Suppressed numbers', summary.suppressed, 'Imported but kept opted out'],
    ['Invalid (no usable phone or email)', invalid, listCounts(summary.invalid) || undefined],
    ['Email warnings', emailWarnings, `INVALID_EMAIL ${formatCount(summary.email_warnings.INVALID_EMAIL)} (value dropped), role address ${formatCount(summary.email_warnings.role)}`],
    ['Suppressed emails', summary.suppressed_emails, 'Imported but kept email opted out'],
    ['No country known', summary.no_country, 'These use the fallback time zone'],
    ['Restricted country', summary.restricted_country, 'Imported; excluded from WhatsApp marketing'],
  ];

  const download = async () => {
    setDownloadError(null);
    try {
      const { url } = await fetchJson<{ url: string }>(`/api/imports/${importId}/rejects`);
      window.location.assign(url);
    } catch (err) {
      setDownloadError((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Step 3: Validate and resolve</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <Table aria-label="Validation summary">
          <TableHeader className="sr-only">
            <TableRow>
              <TableHead>Metric</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {metrics.map(([label, value, note]) => (
              <TableRow key={label}>
                <TableCell className="font-medium">{label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(value)}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Existing contacts</legend>
          <div className="flex flex-wrap gap-4">
            {POLICIES.map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input type="radio" name="policy" className="size-4" checked={policy === value} onChange={() => onPolicy(value)} />
                {label}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Tags are always added. An opted-out contact is never switched back to opted in.</p>
        </fieldset>

        {summary.has_rejects && (
          <div className="space-y-2">
            <Button variant="outline" onClick={download}>Download rejected rows</Button>
            {downloadError && (
              <Alert variant="destructive">
                <AlertDescription>{downloadError}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {(needsWhatsapp || needsEmail) && (
          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Consent confirmation</legend>
            {needsWhatsapp && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={whatsappConsent} onChange={(e) => setWhatsappConsent(e.target.checked)} />
                I confirm these contacts agreed to receive WhatsApp marketing messages from us, and the proof is kept on file.
              </label>
            )}
            {needsEmail && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={emailConsent} onChange={(e) => setEmailConsent(e.target.checked)} />
                I confirm these contacts agreed to receive marketing emails from us, and the proof is kept on file.
              </label>
            )}
          </fieldset>
        )}

        {otherImportBy && (
          <Alert>
            <TriangleAlert aria-hidden />
            <AlertDescription>An import by {otherImportBy} is in progress. You can commit yours when it finishes.</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between">
          <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button>
          <Button
            disabled={!consented || busy || !!otherImportBy || importable === 0}
            onClick={() => onCommit({ consent_confirmed: whatsappConsent, email_consent_confirmed: emailConsent })}
          >
            {busy ? 'Importing…' : `Import ${formatCount(importable)} contacts`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
