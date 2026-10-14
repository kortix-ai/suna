'use client';

import { MinusIcon, TrendDownIcon, TrendUpIcon } from '@phosphor-icons/react';
import { createContext, useContext } from 'react';

import { MarkdownImage, MarkdownLink } from '@/components/markdown/unified-markdown';
import { STATUS_TEXT } from '@/components/ui/status';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import type { GenuiComponentProps } from '../sdk';
import { kids } from './layout';

// The glyph and the color follow the trend; with no trend, the delta's leading sign. The sign and the glyph
// repeat the meaning, so color is not its only carrier (color.md, diff counter).
const TREND = {
  up: { icon: TrendUpIcon, text: STATUS_TEXT.success },
  down: { icon: TrendDownIcon, text: STATUS_TEXT.destructive },
  flat: { icon: MinusIcon, text: 'text-muted-foreground' },
} as const;
const trendOf = (props: Record<string, unknown>): keyof typeof TREND | null => {
  if (props.trend === 'up' || props.trend === 'down' || props.trend === 'flat') return props.trend;
  const sign = /^\s*([+\-−])\s?\S?\d/.exec(String(props.delta ?? ''))?.[1];
  return sign === '+' ? 'up' : sign ? 'down' : null;
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

/** True for a Stat inside a StatRow: it renders as one cell of the row's band. */
const InStatRow = createContext(false);

export function GenuiStat({ props }: GenuiComponentProps) {
  const inRow = useContext(InStatRow);
  const trend = trendOf(props);
  const tone = trend ? TREND[trend] : null;
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', inRow ? 'bg-background px-4 py-3' : 'py-1')}>
      <span className="text-muted-foreground truncate text-xs">{props.label}</span>
      <span className="flex items-baseline gap-1">
        <span className={cn('text-foreground font-medium tracking-tight tabular-nums', inRow ? 'text-lg' : 'text-xl')}>{props.value}</span>
        {props.unit ? <span className="text-muted-foreground text-xs">{props.unit}</span> : null}
      </span>
      {props.delta ? (
        <span className={cn('flex items-center gap-1 text-xs tabular-nums', tone?.text ?? 'text-muted-foreground')}>
          {tone ? <tone.icon className="size-3.5 shrink-0" weight="bold" aria-hidden /> : null}
          {String(props.delta)}
        </span>
      ) : null}
    </div>
  );
}

export function GenuiStatRow({ props, renderChild }: GenuiComponentProps) {
  // One band split by hairlines: the 1px gap shows the border color between cells, and it still draws
  // right when auto-fit wraps the cells onto a second line in a narrow message column.
  return (
    <InStatRow.Provider value>
      <div className="border-border bg-border grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-px overflow-hidden rounded-lg border">
        {kids(props.stats).map(renderChild)}
      </div>
    </InStatRow.Provider>
  );
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
  const table = (
    <Table aria-label={props.caption ? String(props.caption) : undefined}>
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
              // Text wraps (a cell holds up to 200 characters); numbers stay on one line.
              <TableCell key={c} className={cn(numeric[c] ? 'text-right tabular-nums' : 'min-w-32 whitespace-normal')}>
                {String(row[c] ?? '')}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  if (!props.caption) return table;
  // The caption is the table's title: above it, on the left, outside the frame.
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-foreground text-sm font-medium text-pretty">{props.caption}</figcaption>
      {table}
    </figure>
  );
}

export function GenuiCompare({ props }: GenuiComponentProps) {
  const t = useTranslations('genui');
  const items = kids(props.items);
  const specs = strings(props.specs);
  const hasNotes = items.some((item) => strings(item.props.pros).length + strings(item.props.cons).length > 0);
  // Paper Compare 03: the pick's whole column sits on the hover tint, so the eye reads down it. No visible label.
  const pick = (item: (typeof items)[number]) => (props.winner === item.props.name ? 'bg-hover' : undefined);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead />
          {items.map((item) => (
            <TableHead key={item.id} className={cn(pick(item), pick(item) && 'text-foreground font-medium')}>
              {String(item.props.name)}
              {/* The tint marks the pick; screen readers hear it named, since a tint alone reaches none. */}
              {pick(item) ? <span className="sr-only">{t('pick')}</span> : null}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {specs.map((spec, i) => (
          <TableRow key={i}>
            <TableCell className="text-muted-foreground">{spec}</TableCell>
            {items.map((item) => (
              <TableCell key={item.id} className={cn('min-w-32 whitespace-normal', pick(item))}>
                {strings(item.props.values)[i] ?? '—'}
              </TableCell>
            ))}
          </TableRow>
        ))}
        {hasNotes ? (
          <TableRow>
            <TableCell />
            {items.map((item) => (
              <TableCell key={item.id} className={cn('min-w-48 align-top whitespace-normal', pick(item))}>
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
  // Winner + runners-up (Paper RankedList round 2, 13 and 17): no tiles. The rank is a mono number in a
  // fixed right-aligned lane on the title's line, so "10" lines up with "9"; #1 takes the larger title and
  // ink; hairlines separate the rows; the meta sits right on the title line.
  return (
    <ol className="divide-border flex flex-col divide-y">
      {kids(props.items).map((item, index) => {
        const first = index === 0;
        const title = String(item.props.title);
        return (
          <li key={item.id} className={cn('flex items-start gap-3', first ? 'pt-1 pb-3.5' : 'py-2.5')}>
            <span
              className={cn(
                'w-5 shrink-0 text-right font-mono text-xs whitespace-nowrap tabular-nums',
                // The lane's line box matches the title's, so the number sits on the title's baseline.
                first ? 'text-foreground font-medium leading-6' : 'text-muted-foreground leading-5',
              )}
            >
              {index + 1}
            </span>
            {item.props.image ? (
              <span className="bg-muted size-10 shrink-0 overflow-hidden rounded-md [&>span]:size-full [&_img]:size-full [&_img]:rounded-none [&_img]:object-cover [&_img]:outline-0">
                <MarkdownImage src={String(item.props.image)} alt="" flush compact />
              </span>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className={cn('text-foreground min-w-0 font-medium text-balance', first ? 'text-base leading-6' : 'text-sm leading-5')}>
                  {item.props.href ? <MarkdownLink href={String(item.props.href)}>{title}</MarkdownLink> : title}
                </span>
                {item.props.meta ? (
                  <span className={cn('max-w-32 shrink-0 text-right text-sm tabular-nums', first ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {String(item.props.meta)}
                  </span>
                ) : null}
              </div>
              <span className="text-muted-foreground text-sm text-pretty">{String(item.props.reason)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
