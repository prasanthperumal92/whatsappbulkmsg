import Papa from 'papaparse';

// CSVs are parsed as data only, every cell as text with no type inference (§4.5, §12).

export const MAX_ROWS = 200_000;
export const MAX_COLUMNS = 200;

export type ParseOptions = { delimiter: string; quote: string; header_row: boolean; rows_to_skip: number };
export type ParsedCsv = { headers: string[]; rows: string[][] };

export class ImportLimitError extends Error {}

/** A, B … Z, AA … the way a spreadsheet names columns. */
export function columnLetter(index: number): string {
  let out = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) out = String.fromCharCode(65 + (n % 26)) + out;
  return out;
}

const limitMessage = {
  rows: `This file has more than ${MAX_ROWS.toLocaleString('en')} rows. Split it and import each part separately.`,
  columns: `This file has more than ${MAX_COLUMNS} columns, which is the limit. Remove the columns you don't need.`,
};

export function parseCsv(text: string, options: ParseOptions): ParsedCsv {
  const parsed = Papa.parse<string[]>(text, { delimiter: options.delimiter, quoteChar: options.quote, skipEmptyLines: true, header: false });
  const all = parsed.data.slice(options.rows_to_skip);
  const first = options.header_row ? all[0] : undefined;
  const rows = options.header_row ? all.slice(1) : all;
  if (rows.length > MAX_ROWS) throw new ImportLimitError(limitMessage.rows);

  let width = first?.length ?? 0;
  for (const row of rows) if (row.length > width) width = row.length;
  if (width > MAX_COLUMNS) throw new ImportLimitError(limitMessage.columns);

  const headers = Array.from({ length: width }, (_, i) => first?.[i]?.trim() || `Col ${columnLetter(i)}`);
  return { headers, rows };
}

export type ColumnStats = { index: number; name: string; fill_percent: number; unique: number };

export function columnStats({ headers, rows }: ParsedCsv): ColumnStats[] {
  return headers.map((name, index) => {
    const seen = new Set<string>();
    let filled = 0;
    for (const row of rows) {
      const cell = row[index]?.trim();
      if (cell) {
        filled++;
        seen.add(cell);
      }
    }
    return { index, name, fill_percent: rows.length ? Math.round((filled / rows.length) * 100) : 0, unique: seen.size };
  });
}
