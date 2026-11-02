import Papa from 'papaparse';

// §5.3 Step 1 detection, shared by the browser preview and the server. Each result has a manual override.

export type Encoding = 'utf-8' | 'windows-1252' | 'utf-16le' | 'utf-16be';
export type Detection = { encoding: Encoding; bom_stripped: boolean; delimiter: string; quote: string; header_row: boolean; rows_to_skip: number };

export const DELIMITERS = [',', ';', '\t', '|'] as const;

export function detectEncoding(bytes: Uint8Array, { truncated = false } = {}): { encoding: Encoding; bom: boolean } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', bom: true };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', bom: true };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', bom: true };

  // UTF-16 without a BOM: every other byte of Latin text is NUL, which real CSV text never contains.
  const sample = bytes.subarray(0, 4096);
  let oddNul = 0;
  let evenNul = 0;
  sample.forEach((b, i) => {
    if (b === 0) {
      if (i % 2) oddNul++;
      else evenNul++;
    }
  });
  if (sample.length >= 4) {
    if (oddNul > sample.length / 4 && evenNul === 0) return { encoding: 'utf-16le', bom: false };
    if (evenNul > sample.length / 4 && oddNul === 0) return { encoding: 'utf-16be', bom: false };
  }
  try {
    // `stream` tolerates a multi-byte character cut off at the end of a browser preview slice.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
    return { encoding: 'utf-8', bom: false };
  } catch {
    return { encoding: 'windows-1252', bom: false };
  }
}

/** TextDecoder strips a leading BOM. */
export const decodeBytes = (bytes: Uint8Array, encoding: Encoding, { truncated = false } = {}) =>
  new TextDecoder(encoding).decode(bytes, { stream: truncated });

function fieldCounts(text: string, delimiter: string, quote: string) {
  const parsed = Papa.parse<string[]>(text, { delimiter, quoteChar: quote, preview: 30, skipEmptyLines: true });
  return parsed.data.map((row) => row.length);
}

function mode(values: number[]): number {
  const seen = new Map<number, number>();
  for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [value, count] of seen) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function detectDelimiter(text: string, quote = '"'): string {
  let best: string = ',';
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = fieldCounts(text, delimiter, quote);
    if (!counts.length) continue;
    const columns = mode(counts);
    if (columns < 2) continue;
    const consistency = counts.filter((c) => c === columns).length / counts.length;
    const score = consistency * consistency * columns;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

export function detectQuote(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  const atBoundary = (q: string) => (sample.match(new RegExp(`(?:^|[,;\\t|\\n])${q}|${q}(?:[,;\\t|\\r\\n]|$)`, 'gm')) ?? []).length;
  return atBoundary('"') === 0 && atBoundary("'") >= 2 ? "'" : '"';
}

/** Leading rows that don't have the file's usual column count are a preamble (IS-13). */
export function detectRowsToSkip(text: string, delimiter: string, quote: string): number {
  const counts = fieldCounts(text, delimiter, quote);
  const columns = mode(counts);
  if (columns < 2) return 0;
  const first = counts.findIndex((c) => c === columns);
  return first > 0 ? first : 0;
}

const LOOKS_LIKE_DATA = /^[\s+()\d.-]*\d[\s()\d.-]{5,}$|@/;

/** A first row holding a phone-like or email-like value is data, not a header (IS-12). */
export function detectHeaderRow(firstRow: string[] | undefined): boolean {
  return !!firstRow && !firstRow.some((cell) => LOOKS_LIKE_DATA.test(cell.trim()));
}

export function detectAll(bytes: Uint8Array, { truncated = false } = {}): Detection & { text: string } {
  const { encoding, bom } = detectEncoding(bytes, { truncated });
  const text = decodeBytes(bytes, encoding, { truncated });
  const quote = detectQuote(text);
  const delimiter = detectDelimiter(text, quote);
  const rows_to_skip = detectRowsToSkip(text, delimiter, quote);
  const sample = Papa.parse<string[]>(text, { delimiter, quoteChar: quote, preview: rows_to_skip + 1, skipEmptyLines: true }).data;
  return { text, encoding, bom_stripped: bom, delimiter, quote, rows_to_skip, header_row: detectHeaderRow(sample[rows_to_skip]) };
}
