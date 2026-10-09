'use client';

import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from '@phosphor-icons/react';

import { MarkdownLink } from '@/components/markdown/unified-markdown';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

import type { GenuiComponentProps } from '../sdk';
import { kids } from './layout';

// A trend is direction, not a verdict (revenue up is good, cost up is not), so the glyph stays ink.
const TREND = { up: ArrowUpRightIcon, down: ArrowDownRightIcon, flat: MinusIcon } as const;

const strings = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

export function GenuiStat({ props }: GenuiComponentProps) {
  const Trend = props.trend ? TREND[props.trend as keyof typeof TREND] : null;
  return (
    <div className="border-border bg-background flex flex-col gap-1 rounded-md border px-4 py-3">
      <span className="text-muted-foreground text-xs">{props.label}</span>
      <span className="text-foreground text-xl font-semibold tabular-nums">
        {props.value}
        {props.unit ? <span className="text-muted-foreground text-sm font-normal"> {props.unit}</span> : null}
      </span>
      {props.delta ? (
        <span className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums">
          {Trend ? <Trend className="size-3.5 shrink-0" aria-hidden /> : null}
          {props.delta}
        </span>
      ) : null}
    </div>
  );
}

export function GenuiStatRow({ props, renderChild }: GenuiComponentProps) {
  // auto-fit: 2 to 4 equal tiles in one row, wrapping by the width the message column has, not the viewport.
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3">{kids(props.stats).map(renderChild)}</div>;
}

/** A column reads as numbers when every filled cell is one: it aligns right, header included. */
const numericColumns = (columns: string[], rows: unknown[][]): boolean[] =>
  columns.map(
    (_, c) => rows.some((row) => typeof row[c] === 'number') && rows.every((row) => row[c] == null || typeof row[c] === 'number'),
  );

export function GenuiTable({ props }: GenuiComponentProps) {
  const columns = props.columns as string[];
  const rows = props.rows as unknown[][];
  const numeric = numericColumns(columns, rows);
  return (
    <Table>
      {props.caption ? <TableCaption className="mt-0 py-2">{props.caption}</TableCaption> : null}
      <TableHeader>
        <TableRow>
          {columns.map((column, c) => (
            <TableHead key={c} className={cn(numeric[c] && 'text-right')}>
              {column}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, r) => (
          <TableRow key={r}>
            {columns.map((_, c) => (
              <TableCell key={c} className={cn(numeric[c] && 'text-right tabular-nums')}>
                {String(row[c] ?? '')}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function GenuiCompare({ props }: GenuiComponentProps) {
  const items = kids(props.items);
  const specs = strings(props.specs);
  const hasNotes = items.some((item) => strings(item.props.pros).length + strings(item.props.cons).length > 0);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead />
          {items.map((item) => (
            <TableHead key={item.id} className={cn(props.winner === item.props.name && 'text-foreground font-medium')}>
              {String(item.props.name)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {specs.map((spec, i) => (
          <TableRow key={i}>
            <TableCell className="text-muted-foreground">{spec}</TableCell>
            {items.map((item) => (
              <TableCell key={item.id}>{strings(item.props.values)[i] ?? '—'}</TableCell>
            ))}
          </TableRow>
        ))}
        {hasNotes ? (
          <TableRow>
            <TableCell />
            {items.map((item) => (
              <TableCell key={item.id} className="min-w-48 align-top whitespace-normal">
                <ul className="flex flex-col gap-1">
                  {strings(item.props.pros).map((pro) => (
                    <li key={`+${pro}`}>+ {pro}</li>
                  ))}
                  {strings(item.props.cons).map((con) => (
                    <li key={`-${con}`} className="text-muted-foreground">
                      − {con}
                    </li>
                  ))}
                </ul>
              </TableCell>
            ))}
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

export function GenuiRankedList({ props }: GenuiComponentProps) {
  return (
    <ol className="flex flex-col gap-2">
      {kids(props.items).map((item, index) => (
        <li key={item.id} className="border-border bg-background flex gap-3 rounded-md border px-4 py-3">
          <span className="text-muted-foreground w-4 shrink-0 text-sm tabular-nums">{index + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-foreground min-w-0 text-sm font-medium text-balance">
                {item.props.href ? <MarkdownLink href={String(item.props.href)}>{String(item.props.title)}</MarkdownLink> : String(item.props.title)}
              </span>
              {item.props.meta ? <span className="text-muted-foreground shrink-0 text-xs">{String(item.props.meta)}</span> : null}
            </div>
            <span className="text-muted-foreground text-sm text-pretty">{String(item.props.reason)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
