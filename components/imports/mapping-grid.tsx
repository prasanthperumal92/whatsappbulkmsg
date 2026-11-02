'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useMemo, useRef } from 'react';
import { columnLetter, type ColumnStats } from '@/lib/imports/csv';
import { normaliseEmail } from '@/lib/contacts/email';
import { normalisePhone } from '@/lib/contacts/phone';
import { STANDARD_TARGETS, TARGET_LABELS, type Mapping, type Target } from '@/lib/imports/mapping';
import { cn } from '@/lib/utils';
import { selectClass } from './types';

const ROW_HEIGHT = 32;
const COLUMN_WIDTH = 180;
const LABEL_WIDTH = 96;

type CellState = 'ok' | 'warn' | 'error';

/** §5.3 highlights: a bad email is amber; a bad phone is amber if the row still has an email, and red otherwise. */
export function rowCellStates(cells: string[], phoneColumn: number | null, emailColumn: number | null, countryCodeColumn: number | null, defaultCountry: string) {
  const states = new Map<number, CellState>();
  const email = emailColumn === null ? null : normaliseEmail(cells[emailColumn]);
  if (email && email.warning === 'INVALID_EMAIL') states.set(emailColumn!, 'warn');
  if (phoneColumn !== null) {
    const countryCode = countryCodeColumn === null ? undefined : cells[countryCodeColumn];
    const phone = normalisePhone(cells[phoneColumn], { countryCode, defaultCountry });
    if ('reject' in phone) {
      if (!email?.email) states.set(phoneColumn, 'error');
      else if (phone.reject !== 'EMPTY_PHONE') states.set(phoneColumn, 'warn');
    }
  } else if (email && !email.email) {
    states.set(emailColumn!, 'error'); // With no phone column, a row without an email is rejected.
  }
  return states;
}

function columnOf(mapping: Mapping, target: Target) {
  const entry = Object.entries(mapping).find(([, t]) => t === target);
  return entry ? Number(entry[0]) : null;
}

const TargetSelect = memo(function TargetSelect({ column, header, value, onChange }: { column: number; header: string; value: Target; onChange: (column: number, target: Target) => void }) {
  const isCustom = value?.startsWith('custom:');
  return (
    <select
      aria-label={`Map ${header} to`}
      className={cn(selectClass, 'w-full')}
      value={value ?? ''}
      onChange={(e) => onChange(column, (e.target.value || null) as Target)}
    >
      <option value="">Ignore</option>
      {STANDARD_TARGETS.map((t) => <option key={t} value={t}>{TARGET_LABELS[t]}</option>)}
      <option value={isCustom ? value! : `custom:${header}`}>{isCustom ? `Custom: ${value!.slice(7)}` : 'Custom field'}</option>
    </select>
  );
});

type Props = {
  headers: string[];
  stats: ColumnStats[] | null;
  rows: string[][];
  mapping: Mapping;
  defaultCountry: string;
  onMap: (column: number, target: Target) => void;
};

export function MappingGrid({ headers, stats, rows, mapping, defaultCountry, onMap }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 10 });
  const width = LABEL_WIDTH + headers.length * COLUMN_WIDTH;
  const columns = { phone: columnOf(mapping, 'phone'), email: columnOf(mapping, 'email'), code: columnOf(mapping, 'country_code') };
  const statsByColumn = useMemo(() => new Map(stats?.map((s) => [s.index, s])), [stats]);

  const headerCell = 'shrink-0 border-r border-b bg-muted/50 px-2 py-1.5 text-xs';
  const label = 'sticky left-0 z-10 shrink-0 border-r border-b bg-muted px-2 py-1.5 text-xs font-medium text-muted-foreground';

  return (
    <div ref={scroller} className="max-h-[420px] overflow-auto rounded-lg border" role="table" aria-label="Column mapping" tabIndex={0}>
      <div className="sticky top-0 z-20 bg-background" style={{ width }} role="rowgroup">
        <div className="flex" role="row">
          <div className={label} style={{ width: LABEL_WIDTH }} role="rowheader" />
          {headers.map((_, i) => <div key={i} className={cn(headerCell, 'font-medium')} style={{ width: COLUMN_WIDTH }} role="columnheader">Col {columnLetter(i)}</div>)}
        </div>
        <div className="flex" role="row">
          <div className={label} style={{ width: LABEL_WIDTH }} role="rowheader">Map to</div>
          {headers.map((h, i) => (
            <div key={i} className={headerCell} style={{ width: COLUMN_WIDTH }} role="cell">
              <TargetSelect column={i} header={h} value={mapping[i] ?? null} onChange={onMap} />
            </div>
          ))}
        </div>
        <div className="flex" role="row">
          <div className={label} style={{ width: LABEL_WIDTH }} role="rowheader">Header</div>
          {headers.map((h, i) => <div key={i} className={cn(headerCell, 'truncate font-medium')} style={{ width: COLUMN_WIDTH }} title={h} role="cell">{h}</div>)}
        </div>
        <div className="flex" role="row">
          <div className={label} style={{ width: LABEL_WIDTH }} role="rowheader">Fill / unique</div>
          {headers.map((_, i) => {
            const s = statsByColumn.get(i);
            return <div key={i} className={cn(headerCell, 'text-muted-foreground tabular-nums')} style={{ width: COLUMN_WIDTH }} role="cell">{s ? `${s.fill_percent}% / ${s.unique.toLocaleString('en-IN')}` : '…'}</div>;
          })}
        </div>
      </div>

      <div className="relative" style={{ height: virtual.getTotalSize(), width }} role="rowgroup">
        {virtual.getVirtualItems().map((item) => {
          const cells = rows[item.index]!;
          const states = rowCellStates(cells, columns.phone, columns.email, columns.code, defaultCountry);
          return (
            <div key={item.key} className="absolute left-0 flex" style={{ top: item.start, height: ROW_HEIGHT }} role="row">
              <div className={cn(label, 'bg-background font-normal')} style={{ width: LABEL_WIDTH, height: ROW_HEIGHT }} role="rowheader">Row {item.index + 1}</div>
              {headers.map((_, i) => {
                const state = states.get(i);
                return (
                  <div
                    key={i}
                    role="cell"
                    data-cell-state={state}
                    title={cells[i]}
                    style={{ width: COLUMN_WIDTH, height: ROW_HEIGHT }}
                    className={cn(
                      'shrink-0 truncate border-r border-b px-2 py-1.5 text-xs',
                      state === 'warn' && 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
                      state === 'error' && 'bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-100',
                    )}
                  >
                    {cells[i]}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
