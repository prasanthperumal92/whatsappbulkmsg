// §12: a cell a spreadsheet would run as a formula gets a leading quote, so an address or name can't execute anything.
export const protectCell = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

const quote = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const line = (cells: (string | number | null | undefined)[]) => cells.map((c) => quote(protectCell(c === null || c === undefined ? '' : String(c)))).join(',');
  return `${[headers, ...rows].map(line).join('\r\n')}\r\n`;
}
