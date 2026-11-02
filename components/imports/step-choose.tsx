'use client';

import { FileUp, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Detection } from '@/lib/imports/detect';
import { cn } from '@/lib/utils';
import { formatCount, selectClass } from './types';

const ENCODINGS = [['utf-8', 'UTF-8'], ['windows-1252', 'Windows-1252'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE']] as const;
const DELIMITERS = [[',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], ['|', 'Pipe']] as const;

type Props = {
  fileName: string | null;
  fileSize: number | null;
  uploadPercent: number | null;
  totalRows: number | null;
  detect: Detection | null;
  duplicateMessage: string | null;
  busy: boolean;
  error: string | null;
  canContinue: boolean;
  onFile: (file: File) => void;
  onDetectChange: (change: Partial<Detection>) => void;
  onContinue: () => void;
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function StepChoose({ fileName, fileSize, uploadPercent, totalRows, detect, duplicateMessage, busy, error, canContinue, onFile, onDetectChange, onContinue }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const uploading = uploadPercent !== null && uploadPercent < 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Step 1: Choose file</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) onFile(file);
          }}
          className={cn('flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-sm transition-colors hover:bg-muted/50', dragging && 'border-primary bg-muted')}
        >
          <FileUp className="size-5 text-muted-foreground" aria-hidden />
          <span className="font-medium">Choose a .csv or .txt file, or drop it here</span>
          <span className="text-xs text-muted-foreground">Up to 200,000 rows and 200 columns</span>
        </button>
        <input
          ref={input}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="sr-only"
          aria-label="CSV file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = '';
          }}
        />

        {fileName && (
          <div className="space-y-1.5" data-testid="upload-status">
            <p className="text-sm">
              <span className="font-medium">{fileName}</span>
              {fileSize !== null && <span className="text-muted-foreground"> · {mb(fileSize)}</span>}
              {totalRows !== null && <span className="text-muted-foreground"> · {formatCount(totalRows)} rows</span>}
              {uploading && <span className="text-muted-foreground"> · uploading {Math.round(uploadPercent)}%</span>}
              {!uploading && busy && <span className="text-muted-foreground"> · analysing…</span>}
            </p>
            {uploadPercent !== null && (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(uploadPercent)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-primary transition-[width]" style={{ width: `${uploadPercent}%` }} />
              </div>
            )}
          </div>
        )}

        {duplicateMessage && (
          <Alert>
            <TriangleAlert aria-hidden />
            <AlertDescription>{duplicateMessage}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {detect && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="grid gap-1.5">
              <Label htmlFor="detect-encoding">Encoding</Label>
              <select id="detect-encoding" className={selectClass} value={detect.encoding} disabled={busy} onChange={(e) => onDetectChange({ encoding: e.target.value as Detection['encoding'] })}>
                {ENCODINGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="detect-delimiter">Delimiter</Label>
              <select id="detect-delimiter" className={selectClass} value={detect.delimiter} disabled={busy} onChange={(e) => onDetectChange({ delimiter: e.target.value })}>
                {DELIMITERS.map(([value, label]) => <option key={label} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="detect-quote">Quote</Label>
              <select id="detect-quote" className={selectClass} value={detect.quote} disabled={busy} onChange={(e) => onDetectChange({ quote: e.target.value })}>
                <option value={'"'}>Double (&quot;)</option>
                <option value="'">Single (&apos;)</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="detect-skip">Rows to skip</Label>
              <Input
                id="detect-skip"
                type="number"
                min={0}
                max={1000}
                className="h-8"
                defaultValue={detect.rows_to_skip}
                key={detect.rows_to_skip}
                disabled={busy}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isInteger(value) && value >= 0 && value !== detect.rows_to_skip) onDetectChange({ rows_to_skip: value });
                }}
              />
            </div>
            <label className="flex items-end gap-2 pb-1.5 text-sm">
              <input type="checkbox" className="size-4" checked={detect.header_row} disabled={busy} onChange={(e) => onDetectChange({ header_row: e.target.checked })} />
              First row is a header
            </label>
          </div>
        )}

        <div className="flex justify-end">
          <Button disabled={!canContinue} onClick={onContinue}>
            Next: Map columns
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
