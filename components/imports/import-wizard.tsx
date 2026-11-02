'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import { useCallback, useRef, useState } from 'react';
import { fetchJson } from '@/lib/client/fetch-json';
import { uploadImportFile } from '@/lib/client/upload-import';
import { columnLetter } from '@/lib/imports/csv';
import { parseCsvPreview } from '@/lib/imports/preview';
import { suggestMapping, type Mapping } from '@/lib/imports/mapping';
import type { Detection } from '@/lib/imports/detect';
import type { Settings } from '@/lib/settings/schema';
import { cn } from '@/lib/utils';
import { StepChoose } from './step-choose';
import { StepMap } from './step-map';
import { StepResult } from './step-result';
import { StepValidate } from './step-validate';
import type { Analysis, CommitResult, MapOptions, Policy, Preset, ValidateSummary } from './types';

const STEPS = ['Choose file', 'Map columns', 'Validate', 'Import'];
const PREVIEW_ROWS = 200;
const PREVIEW_BYTES = 512 * 1024;

type Preview = { headers: string[]; rows: string[][]; detect: Detection };

/** The first 200 rows, parsed in a worker straight from the file, so they appear while the upload is running (§5.3). */
async function previewFile(file: File): Promise<Preview> {
  const slice = new Uint8Array(await file.slice(0, PREVIEW_BYTES).arrayBuffer());
  const truncated = file.size > PREVIEW_BYTES;
  const { text, ...detect } = parseCsvPreview(slice, truncated);
  const parsed = await new Promise<string[][]>((resolve, reject) => {
    Papa.parse<string[]>(text, {
      worker: true,
      delimiter: detect.delimiter,
      quoteChar: detect.quote,
      skipEmptyLines: true,
      preview: detect.rows_to_skip + PREVIEW_ROWS + 2,
      complete: (results) => resolve(results.data),
      error: (err: Error) => reject(err),
    });
  });
  const all = parsed.slice(detect.rows_to_skip);
  const first = detect.header_row ? all[0] : undefined;
  const rows = (detect.header_row ? all.slice(1) : all).slice(0, PREVIEW_ROWS);
  const width = Math.max(first?.length ?? 0, ...rows.slice(0, 50).map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => first?.[i]?.trim() || `Col ${columnLetter(i)}`);
  return { headers, rows, detect };
}

export function ImportWizard() {
  const client = useQueryClient();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [options, setOptions] = useState<Partial<MapOptions>>({});
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [summary, setSummary] = useState<ValidateSummary | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const currentRun = useRef(0);

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchJson<Settings>('/api/settings') });
  const presets = useQuery({ queryKey: ['mapping-presets'], queryFn: () => fetchJson<{ items: Preset[] }>('/api/mapping-presets') });
  const active = useQuery({
    queryKey: ['imports-active'],
    queryFn: () => fetchJson<{ active: { by: string | null; id: string; mine: boolean } | null }>('/api/imports/active'),
    refetchInterval: 5000,
  });

  const defaults = settings.data?.import;
  const mapOptions: MapOptions = {
    default_country: options.default_country ?? defaults?.defaultCountry ?? 'IN',
    tag_separator: options.tag_separator ?? ';',
    apply_tags: options.apply_tags ?? '',
    opt_in_value: options.opt_in_value ?? defaults?.defaultWhatsappOptIn ?? 'unknown',
    email_opt_in_value: options.email_opt_in_value ?? defaults?.defaultEmailOptIn ?? 'unknown',
    consent_proof_value: options.consent_proof_value ?? '',
  };
  const chosenPolicy: Policy = policy ?? defaults?.existingContactPolicy ?? 'fill_empty';

  const applyAnalysis = useCallback((next: Analysis) => {
    setAnalysis(next);
    setMapping(next.preset?.mapping ?? next.suggestions);
    setActivePreset(next.preset?.id ?? null);
  }, []);

  const analyze = useMutation({
    mutationFn: ({ id, overrides }: { id: string; overrides: Partial<Detection> }) =>
      fetchJson<Analysis>(`/api/imports/${id}/analyze`, { method: 'POST', body: JSON.stringify(overrides) }),
    onSuccess: applyAnalysis,
    onError: (err) => setFileError(err.message),
  });

  const reset = () => {
    currentRun.current++;
    setStep(0);
    setFile(null);
    setUploadPercent(null);
    setPreview(null);
    setImportId(null);
    setDuplicateMessage(null);
    setAnalysis(null);
    setMapping({});
    setActivePreset(null);
    setOptions({});
    setPolicy(null);
    setSummary(null);
    setResult(null);
    setFileError(null);
    validate.reset();
    commit.reset();
    analyze.reset();
  };

  const onFile = async (chosen: File) => {
    const run = ++currentRun.current;
    const stale = () => run !== currentRun.current;
    setFile(chosen);
    setFileError(null);
    setPreview(null);
    setAnalysis(null);
    setImportId(null);
    setDuplicateMessage(null);
    setUploadPercent(0);
    setMapping({});
    setActivePreset(null);

    // The preview and the upload start together and neither waits for the other.
    previewFile(chosen)
      .then((p) => {
        if (stale()) return;
        setPreview(p);
        setMapping((m) => (Object.keys(m).length ? m : p.detect.header_row ? suggestMapping(p.headers) : {}));
      })
      .catch(() => {}); // Analysis reports a file it can't read.

    try {
      const { blob_path, sha256 } = await uploadImportFile(chosen, (percent) => {
        if (!stale()) setUploadPercent(percent);
      });
      if (stale()) return;
      setUploadPercent(100);
      const registered = await fetchJson<{ import_id: string; duplicate_of?: { message: string } }>('/api/imports', {
        method: 'POST',
        body: JSON.stringify({ blob_path, file_name: chosen.name, sha256 }),
      });
      if (stale()) return;
      setImportId(registered.import_id);
      setDuplicateMessage(registered.duplicate_of?.message ?? null);
      analyze.mutate({ id: registered.import_id, overrides: {} });
    } catch (err) {
      if (!stale()) {
        setUploadPercent(null);
        setFileError((err as Error).message);
      }
    }
  };

  const onDetectChange = (change: Partial<Detection>) => {
    if (!importId || !analysis) return;
    setFileError(null);
    analyze.mutate({ id: importId, overrides: { ...analysis.detect, ...change } });
  };

  const savePreset = useMutation({
    mutationFn: (name: string) =>
      fetchJson<Preset>('/api/mapping-presets', { method: 'POST', body: JSON.stringify({ name, header_signature: analysis?.header_signature, mapping }) }),
    onSuccess: async (saved) => {
      setActivePreset(saved.id);
      await client.invalidateQueries({ queryKey: ['mapping-presets'] });
    },
  });

  const validate = useMutation({
    mutationFn: () =>
      fetchJson<ValidateSummary>(`/api/imports/${importId}/validate`, {
        method: 'POST',
        body: JSON.stringify({
          mapping,
          options: {
            ...analysis?.detect,
            default_country: mapOptions.default_country,
            tag_separator: mapOptions.tag_separator,
            apply_tags: mapOptions.apply_tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean),
            opt_in_value: mapOptions.opt_in_value,
            email_opt_in_value: mapOptions.email_opt_in_value,
            consent_proof_value: mapOptions.consent_proof_value.trim() || null,
          },
        }),
      }),
    onSuccess: (next) => {
      setSummary(next);
      setStep(2);
    },
  });

  const commit = useMutation({
    mutationFn: (consent: { consent_confirmed: boolean; email_consent_confirmed: boolean }) =>
      fetchJson<CommitResult>(`/api/imports/${importId}/commit`, { method: 'POST', body: JSON.stringify({ policy: chosenPolicy, ...consent }) }),
    onSuccess: (next) => {
      setResult(next);
      setStep(3);
    },
    onSettled: () => active.refetch(),
  });

  const activeBy = active.data?.active;
  const otherImportBy = activeBy && !activeBy.mine ? (activeBy.by ?? 'a team member') : null;

  const headers = analysis?.preview_headers ?? preview?.headers ?? [];
  const rows = analysis?.preview_rows ?? preview?.rows ?? [];

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Import steps">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? 'step' : undefined} className={cn(i === step ? 'font-medium' : 'text-muted-foreground')}>
            {i + 1} {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <StepChoose
            fileName={file?.name ?? null}
            fileSize={file?.size ?? null}
            uploadPercent={uploadPercent}
            totalRows={analysis?.total_rows ?? null}
            detect={analysis?.detect ?? preview?.detect ?? null}
            duplicateMessage={duplicateMessage}
            busy={analyze.isPending || !analysis}
            error={fileError}
            canContinue={!!analysis && !analyze.isPending}
            onFile={onFile}
            onDetectChange={onDetectChange}
            onContinue={() => setStep(1)}
          />
          {!!rows.length && (
            <section aria-label="File preview" data-testid="file-preview" className="overflow-auto rounded-lg border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50">
                  <tr>{headers.map((h, i) => <th key={i} scope="col" className="whitespace-nowrap border-b px-2 py-1.5 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((row, r) => (
                    <tr key={r}>{headers.map((_, i) => <td key={i} className="max-w-48 truncate border-b px-2 py-1.5">{row[i]}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {step === 1 && (
        <StepMap
          headers={headers}
          stats={analysis?.columns ?? null}
          rows={rows}
          mapping={mapping}
          options={mapOptions}
          presets={presets.data?.items ?? []}
          activePreset={activePreset}
          headerSignature={analysis?.header_signature ?? null}
          busy={validate.isPending}
          error={validate.error?.message ?? savePreset.error?.message ?? null}
          onMapping={(next) => {
            setMapping(next);
            setActivePreset(null);
          }}
          onOptions={(change) => setOptions((o) => ({ ...o, ...change }))}
          onApplyPreset={(preset) => {
            setMapping(preset.mapping);
            setActivePreset(preset.id);
          }}
          onSavePreset={(name) => savePreset.mutate(name)}
          savingPreset={savePreset.isPending}
          onBack={() => setStep(0)}
          onNext={() => validate.mutate()}
        />
      )}

      {step === 2 && summary && importId && (
        <StepValidate
          importId={importId}
          summary={summary}
          policy={chosenPolicy}
          otherImportBy={otherImportBy}
          busy={commit.isPending}
          error={commit.error?.message ?? null}
          onPolicy={setPolicy}
          onBack={() => setStep(1)}
          onCommit={(consent) => commit.mutate(consent)}
        />
      )}

      {step === 3 && result && <StepResult result={result} onStartOver={reset} />}
    </div>
  );
}
