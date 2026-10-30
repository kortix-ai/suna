'use client';

import { MinusIcon, TrendDownIcon, TrendUpIcon } from '@phosphor-icons/react';
import { createContext, useContext, useState } from 'react';

import { MarkdownImage, MarkdownLink } from '../../unified-markdown';
import { Checkbox } from '../../../primitives/checkbox';
import { Progress } from '../../../primitives/progress';
import { STATUS_TEXT } from '../../../primitives/status';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../primitives/table';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';

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
              <span className={cn('text-foreground min-w-0 font-medium text-balance', first ? 'text-base leading-6' : 'text-sm leading-5')}>
                {item.props.href ? <MarkdownLink href={String(item.props.href)}>{title}</MarkdownLink> : title}
              </span>
              {/* The meta is its own line under the title, as a price or spec line: a side column squeezes a sentence. */}
              {item.props.meta ? <span className="text-foreground text-sm font-medium tabular-nums">{String(item.props.meta)}</span> : null}
              <span className="text-muted-foreground text-sm text-pretty">{String(item.props.reason)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A journey or a process (ChatGPT's "journey at a glance"): each row is a cropped photo on a rail, the title with
 * its meta on the right, and the text lines. A hairline under each photo joins it to the next row. A row with no
 * photo, a photo that fails to load, or a step still streaming shows its number in a dot on the same rail, so the
 * order still reads and a half-written URL never loads.
 */
export function GenuiSteps({ props }: GenuiComponentProps) {
  const steps = kids(props.steps);
  // Keyed by URL, not by step: a step whose URL changes gets a fresh try.
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  // A list whose every photo failed goes back to the narrow numbered rail.
  const photos = steps.some((step) => step.props.image && !failed.has(String(step.props.image)));
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const src = step.partial || !step.props.image ? null : String(step.props.image);
        const image = src && !failed.has(src) ? src : null;
        return (
          <li key={step.id} className="flex gap-4">
            <div className={cn('flex shrink-0 flex-col items-center', photos ? 'w-26' : 'w-7')}>
              {image ? (
                <span className="bg-muted size-26 shrink-0 overflow-hidden rounded-lg [&>span]:size-full [&_img]:size-full [&_img]:rounded-none [&_img]:object-cover [&_img]:outline-0">
                  <MarkdownImage src={image} alt="" flush compact onError={() => setFailed((known) => new Set(known).add(image))} />
                </span>
              ) : photos ? (
                // In a list with photos, a row without one keeps the same thumbnail size: its number on the well.
                <span aria-hidden className="bg-muted text-muted-foreground flex size-26 shrink-0 items-center justify-center rounded-lg font-mono text-sm tabular-nums">
                  {index + 1}
                </span>
              ) : (
                <span aria-hidden className="bg-muted text-foreground flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-xs tabular-nums">
                  {index + 1}
                </span>
              )}
              {last ? null : <span className="bg-border my-1.5 min-h-5 w-px flex-1" aria-hidden />}
            </div>
            <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', !last && 'pb-5', !photos && 'pt-1')}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-foreground min-w-0 text-sm font-medium text-balance">{String(step.props.title ?? '')}</span>
                {step.props.meta ? (
                  <span className="text-muted-foreground max-w-32 shrink-0 text-right text-xs tabular-nums">{String(step.props.meta)}</span>
                ) : null}
              </div>
              {step.props.text ? <p className="text-foreground text-sm text-pretty whitespace-pre-line">{String(step.props.text)}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Things to tick off, with a "3/9 ready" count and a bar. Ticks live in this component only: no store, no request. */
export function GenuiChecklist({ props }: GenuiComponentProps) {
  const t = useTranslations('genui');
  const items = strings(props.items);
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const toggle = (index: number, on: boolean) =>
    setDone((known) => {
      const next = new Set(known);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  return (
    <div className="border-border flex flex-col gap-3 rounded-xl border px-4 py-3.5">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-foreground min-w-0 text-sm font-medium text-balance">{String(props.title)}</span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{t('checklistReady', { done: done.size, total: items.length })}</span>
        </div>
        <Progress aria-hidden value={items.length === 0 ? 0 : (done.size / items.length) * 100} className="bg-muted h-1" indicatorClassName="bg-foreground" />
      </div>
      <ul className="flex flex-col">
        {items.map((item, index) => (
          <li key={index}>
            {/* -mx-3 w-auto: the box lines up with the title, and the row tint spans the card's padding on both sides. */}
            <Checkbox
              checked={done.has(index)}
              onCheckedChange={(value) => toggle(index, value === true)}
              className="-mx-3 w-auto"
              label={<span className={cn('text-foreground', done.has(index) && 'text-muted-foreground font-normal line-through')}>{item}</span>}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
