import type { ColumnStats } from '@/lib/imports/csv';
import type { Detection } from '@/lib/imports/detect';
import type { Mapping } from '@/lib/imports/mapping';
import type { ImportSummary } from '@/lib/imports/plan';

export type Analysis = {
  detect: Detection;
  total_rows: number;
  columns: ColumnStats[];
  preview_headers: string[];
  preview_rows: string[][];
  suggestions: Mapping;
  header_signature: string | null;
  preset: { id: string; name: string; mapping: Mapping } | null;
};

export type ConsentValue = 'opted_in' | 'unknown' | 'opted_out';

export type MapOptions = {
  default_country: string;
  tag_separator: string;
  apply_tags: string;
  opt_in_value: ConsentValue;
  email_opt_in_value: ConsentValue;
  consent_proof_value: string;
};

export type ValidateSummary = ImportSummary & { has_rejects: boolean };
export type CommitResult = { import_id: string; new_rows: number; updated_rows: number; unchanged_rows: number; summary: ImportSummary };
export type ImportInfo = { id: string; status: string; undo_blocked_reason: string | null };
export type Preset = { id: string; name: string; header_signature: string; mapping: Mapping };
export type Policy = 'skip' | 'fill_empty' | 'overwrite';

export const formatCount = (n: number) => n.toLocaleString('en-IN');
export const selectClass = 'h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';
