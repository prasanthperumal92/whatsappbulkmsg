'use client';

import { getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ColumnStats } from '@/lib/imports/csv';
import { mappingProblem, type Mapping, type Target } from '@/lib/imports/mapping';
import { MappingGrid } from './mapping-grid';
import { selectClass, type ConsentValue, type MapOptions, type Preset } from './types';

const COUNTRIES = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return getCountries()
    .map((code) => ({ code, label: `${names.of(code) ?? code} (+${getCountryCallingCode(code)})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
})();

const CONSENT_LABELS: Record<ConsentValue, string> = { unknown: 'unknown', opted_in: 'opted in', opted_out: 'opted out' };

function ConsentSelect({ id, label, value, column, onChange }: { id: string; label: string; value: ConsentValue; column: string | null; onChange: (v: ConsentValue) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {column ? (
        <p id={id} className="flex h-8 items-center text-sm text-muted-foreground">From column {column}</p>
      ) : (
        <select id={id} className={selectClass} value={value} onChange={(e) => onChange(e.target.value as ConsentValue)}>
          {(Object.keys(CONSENT_LABELS) as ConsentValue[]).map((v) => <option key={v} value={v}>Whole file: {CONSENT_LABELS[v]}</option>)}
        </select>
      )}
    </div>
  );
}

type Props = {
  headers: string[];
  stats: ColumnStats[] | null;
  rows: string[][];
  mapping: Mapping;
  options: MapOptions;
  presets: Preset[];
  activePreset: string | null;
  headerSignature: string | null;
  busy: boolean;
  error: string | null;
  onMapping: (mapping: Mapping) => void;
  onOptions: (change: Partial<MapOptions>) => void;
  onApplyPreset: (preset: Preset) => void;
  onSavePreset: (name: string) => void;
  savingPreset: boolean;
  onBack: () => void;
  onNext: () => void;
};

export function StepMap({ headers, stats, rows, mapping, options, presets, activePreset, headerSignature, busy, error, onMapping, onOptions, onApplyPreset, onSavePreset, savingPreset, onBack, onNext }: Props) {
  const [presetName, setPresetName] = useState('');
  const problem = useMemo(() => mappingProblem(mapping), [mapping]);
  const columnFor = (target: Target) => {
    const entry = Object.entries(mapping).find(([, t]) => t === target);
    return entry ? headers[Number(entry[0])] ?? null : null;
  };

  /** A target belongs to one column (Tags can merge several), so choosing it takes it from any other column. */
  const onMap = (column: number, target: Target) => {
    const next: Mapping = { ...mapping };
    if (target && target !== 'tags') {
      for (const [key, value] of Object.entries(next)) if (value === target) next[key] = null;
    }
    next[column] = target;
    onMapping(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Step 2: Map columns</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="preset">Preset</Label>
            <select
              id="preset"
              className={selectClass}
              value={activePreset ?? ''}
              onChange={(e) => {
                const preset = presets.find((p) => p.id === e.target.value);
                if (preset) onApplyPreset(preset);
              }}
            >
              <option value="">None</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {headerSignature && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (presetName.trim()) onSavePreset(presetName.trim());
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="preset-name">Preset name</Label>
                <Input id="preset-name" className="h-8" value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Expo leads" />
              </div>
              <Button type="submit" variant="outline" disabled={!!problem || !presetName.trim() || savingPreset}>Save preset</Button>
            </form>
          )}
        </div>

        <MappingGrid headers={headers} stats={stats} rows={rows} mapping={mapping} defaultCountry={options.default_country} onMap={onMap} />
        <p className="text-xs text-muted-foreground">
          First {rows.length.toLocaleString('en-IN')} rows shown. <span className="rounded-sm bg-amber-100 px-1 text-amber-950 dark:bg-amber-950 dark:text-amber-100">Amber</span> imports with a warning.{' '}
          <span className="rounded-sm bg-red-100 px-1 text-red-950 dark:bg-red-950 dark:text-red-100">Red</span> will be rejected.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="default-country">Default country for this file</Label>
            <select id="default-country" className={selectClass} value={options.default_country} onChange={(e) => onOptions({ default_country: e.target.value })}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tag-separator">Tag separator</Label>
            <Input id="tag-separator" className="h-8" maxLength={4} value={options.tag_separator} onChange={(e) => onOptions({ tag_separator: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="apply-tags">Apply tags to every row</Label>
            <Input id="apply-tags" className="h-8" placeholder="expo-2026" value={options.apply_tags} onChange={(e) => onOptions({ apply_tags: e.target.value })} />
          </div>
          <ConsentSelect id="whatsapp-opt-in" label="WhatsApp opt-in" value={options.opt_in_value} column={columnFor('opt_in')} onChange={(opt_in_value) => onOptions({ opt_in_value })} />
          <ConsentSelect id="email-opt-in" label="Email opt-in" value={options.email_opt_in_value} column={columnFor('email_opt_in')} onChange={(email_opt_in_value) => onOptions({ email_opt_in_value })} />
          <div className="grid gap-1.5">
            <Label htmlFor="consent-proof">Consent proof reference</Label>
            {columnFor('consent_proof') ? (
              <p className="flex h-8 items-center text-sm text-muted-foreground">From column {columnFor('consent_proof')}</p>
            ) : (
              <Input id="consent-proof" className="h-8" placeholder="Where the proof is kept" value={options.consent_proof_value} onChange={(e) => onOptions({ consent_proof_value: e.target.value })} />
            )}
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" onClick={onBack}>Back</Button>
          <div className="flex items-center gap-3">
            {problem && <p className="text-sm text-muted-foreground" role="status">{problem}</p>}
            <Button disabled={!!problem || busy || !options.tag_separator} onClick={onNext}>
              {busy ? 'Validating…' : 'Next: Validate'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
