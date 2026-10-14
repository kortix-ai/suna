'use client';

/**
 * Bar, line and pie charts for generative UI. `index.tsx` loads this module
 * through `lazy()`, so recharts and the `@kortix/sdk/genui` barrel load with
 * the first chart, not with every reply.
 *
 * COLOR (dataviz `validate_palette.js`, all pairs, light #ffffff / dark #0b0b0b):
 * `--chart-1..5` is the brand's one data-viz ramp, sequential and
 * theme-invariant; adjacent steps are too close for categories (ΔE 11.1, floor
 * 15). Series take chart-3, chart-5, then ink (`--foreground`), then chart-1:
 * - 2 and 3 series: every pair ΔE ≥ 19.6 in both themes; light contrast all ≥ 3:1.
 * - Limits the ramp keeps: chart-5 is 2.78:1 on dark (from 2 series), and
 *   chart-1 is 1.45:1 on light (from the 4th series). The legend names every
 *   series in ink, a single one included, and the Show data table carries
 *   every value as text.
 * - Pie slices 5 and 6 take chart-4 and chart-2; adjacent slices pass
 *   (ΔE ≥ 19.6) and sit on a 2px surface gap.
 * Mobile uses the same order.
 *
 * HEIGHT: the closed figure is `CHART_FIGURE_HEIGHT` (arithmetic in
 * `pending.tsx`), the same box the pending block reserves.
 *
 * MOTION: none. A chart answers a question; it is not a moment.
 */

// eslint-disable-next-line no-restricted-imports -- screen-reader text for the figure; this module is reached only through lazy()
import { genuiA11yText } from '@kortix/sdk/genui';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts';

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import type { GenuiComponentProps, GenuiNode } from '../sdk';
import { kids } from './layout';
import { CHART_FIGURE_HEIGHT, GenuiPending } from './pending';

// Recharts 3 draws tick text outside `.recharts-cartesian-axis-tick`, so ChartContainer's tick class
// misses it and the text keeps Recharts' fixed #666 in both themes.
const AXIS_TICK = { fill: 'var(--muted-foreground)' };
const PALETTE = ['var(--chart-3)', 'var(--chart-5)', 'var(--foreground)', 'var(--chart-1)', 'var(--chart-4)', 'var(--chart-2)'];

type Entry = { key: string; label: string; color: string };
type Cell = string | number | null;

// Pie slices are one ink ramp, largest share darkest (Paper PieChart page). It reads in both themes and
// leaves the one accent for `focus`, where it marks the slice the answer is about.
const PIE_RAMP = [100, 70, 50, 34, 22, 12].map((step) => `color-mix(in oklab, var(--foreground) ${step}%, transparent)`);
const PIE_ACCENT = 'var(--kortix-base)';

type PieVariant = 'donut' | 'focus' | 'ring' | 'treemap' | 'gauge' | 'stack';
type PieSlice = { key: string; label: string; value: number; fill: string; percent: number };

/**
 * The series or slice a reader is pointing at. Hover previews one; a click selects one and it stays
 * selected until it is clicked again. `key` is what the chart shows: the hovered item, else the selected one.
 * Every other series dims to `DIMMED`.
 */
type Focus = { key: string | null; selected: string | null; hover: (key: string | null) => void; toggle: (key: string) => void };
const DIMMED = 0.15;
const dimmed = (focus: Focus, key: string) => (focus.key !== null && focus.key !== key ? DIMMED : 1);

function useFocus(): Focus {
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  return {
    key: hovered ?? selected,
    selected,
    hover: setHovered,
    toggle: (key) => setSelected((current) => (current === key ? null : key)),
  };
}

/**
 * A legend item: hover or keyboard focus previews its series; a click (or Enter / Space) selects it and
 * keeps it focused. The hover pill is the app's hover fill with rounded ends; a selected item keeps it.
 */
function legendTarget(focus: Focus, key: string) {
  const selected = focus.selected === key;
  return {
    tabIndex: 0,
    role: 'button' as const,
    'aria-pressed': selected,
    onMouseEnter: () => focus.hover(key),
    onMouseLeave: () => focus.hover(null),
    onFocus: () => focus.hover(key),
    onBlur: () => focus.hover(null),
    onClick: () => focus.toggle(key),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      focus.toggle(key);
    },
    className: cn(
      'hover:bg-hover focus-visible:bg-hover duration-fast cursor-pointer rounded-sm transition-colors outline-none',
      selected && 'bg-hover text-foreground',
    ),
  };
}

function PieFigure({
  variant,
  slices,
  total,
  unit,
  format,
  tooltip,
  focus,
}: {
  variant: PieVariant;
  slices: PieSlice[];
  total: number;
  unit: string | undefined;
  format: (value: unknown) => string;
  tooltip: React.ReactElement;
  focus: Focus;
}) {
  const t = useTranslations('genui');
  const data = variant === 'focus' ? slices.map((slice, i) => (i === 0 ? { ...slice, fill: PIE_ACCENT } : slice)) : slices;
  const config: ChartConfig = Object.fromEntries(data.map(({ key, label, fill }) => [key, { label, color: fill }]));
  const lead = slices.reduce((max, slice) => (slice.value > max.value ? slice : max), slices[0]!);
  const pie = (props: Partial<React.ComponentProps<typeof Pie>>, className: string) => (
    <ChartContainer config={config} className={cn('aspect-square shrink-0', className)}>
      <PieChart>
        <ChartTooltip isAnimationActive={false} content={tooltip} />
        <Pie data={data} dataKey="value" nameKey="label" stroke="var(--background)" strokeWidth={2} isAnimationActive={false} {...props}>
          {data.map((slice) => (
            <Cell key={slice.key} fill={slice.fill} fillOpacity={dimmed(focus, slice.key)} className="duration-fast transition-[fill-opacity]" />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
  const dot = (fill: string) => <span className="size-2 shrink-0 rounded-xs" style={{ backgroundColor: fill }} aria-hidden />;
  const centered = (big: string, small: string | undefined) => (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
      <span className="text-foreground text-2xl font-medium tracking-tight tabular-nums">{big}</span>
      {small ? <span className="text-muted-foreground text-xs">{small}</span> : null}
    </div>
  );

  if (variant === 'treemap') {
    // Slice-and-dice: the largest share takes its width; the rest stack in a column by their share. A block
    // under 12% of its column is too small for text, so it shows nothing and its hover card carries the data.
    // Every block has the card, so a reader can check any share without opening the table.
    const [first, ...rest] = [...slices].sort((a, b) => b.value - a.value);
    const restTotal = rest.reduce((sum, slice) => sum + slice.value, 0);
    const block = (slice: PieSlice, i: number) => {
      const small = i > 0 && slice.value / restTotal < 0.12;
      return (
        <HoverCard key={slice.key} openDelay={80} closeDelay={40}>
          <HoverCardTrigger asChild>
            <div
              tabIndex={0}
              onMouseEnter={() => focus.hover(slice.key)}
              onMouseLeave={() => focus.hover(null)}
              onClick={() => focus.toggle(slice.key)}
              aria-label={`${slice.label}: ${format(slice.value)} (${slice.percent}%)`}
              className={cn(
                'focus-visible:ring-ring duration-fast flex min-h-1.5 min-w-0 flex-col justify-between overflow-hidden rounded-md transition-opacity outline-none focus-visible:ring-2',
                small ? 'p-0' : 'p-3',
                i < 2 ? 'text-background' : 'text-foreground',
              )}
              style={{ backgroundColor: PIE_RAMP[i], flexGrow: slice.value, flexBasis: 0, opacity: dimmed(focus, slice.key) }}
            >
              {small ? null : (
                <>
                  <span className="truncate text-xs">{slice.label}</span>
                  <span className={cn('truncate tabular-nums', i === 0 ? 'text-2xl font-medium' : 'text-sm')}>{slice.percent}%</span>
                </>
              )}
            </div>
          </HoverCardTrigger>
          <HoverCardContent side="top" className="flex w-auto min-w-40 flex-col gap-1 p-3">
            <span className="text-foreground flex items-center gap-2 text-sm font-medium">
              {dot(slice.fill)}
              {slice.label}
            </span>
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {unit ? `${format(slice.value)} ${unit}` : format(slice.value)} · {slice.percent}%
            </span>
          </HoverCardContent>
        </HoverCard>
      );
    };
    return (
      <div className="flex min-h-0 flex-1 gap-1">
        {block(first!, 0)}
        {rest.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1" style={{ flexGrow: restTotal, flexBasis: 0 }}>
            {rest.map((slice, i) => block(slice, i + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  if (variant === 'stack') {
    // A receipt: each row is as tall as its share, so the label sits level with its segment.
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-0.5">
        {slices.map((slice) => (
          <div
            key={slice.key}
            {...legendTarget(focus, slice.key)}
            className={cn(legendTarget(focus, slice.key).className, 'flex min-h-5 items-center gap-4 pr-1.5')}
            style={{ flexGrow: slice.value, flexBasis: 0 }}
          >
            <span
              className="duration-fast h-full w-11 shrink-0 rounded-xs transition-opacity"
              style={{ backgroundColor: slice.fill, opacity: dimmed(focus, slice.key) }}
              aria-hidden
            />
            <span className="text-foreground min-w-0 flex-1 truncate text-sm">{slice.label}</span>
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {format(slice.value)} · {slice.percent}%
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'gauge') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <div className="relative h-[120px] w-[240px] overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-[240px]">
            {pie({ startAngle: 180, endAngle: 0, innerRadius: '72%', outerRadius: '100%' }, 'size-full')}
          </div>
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
            <span className="text-foreground text-2xl font-medium tracking-tight tabular-nums">{format(total)}</span>
            {unit ? <span className="text-muted-foreground text-xs">{unit}</span> : null}
          </div>
        </div>
        <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
          {slices.map((slice) => (
            <li key={slice.key} {...legendTarget(focus, slice.key)} className={cn(legendTarget(focus, slice.key).className, 'text-foreground flex items-center gap-1.5 px-1.5 py-0.5')}>
              {dot(slice.fill)}
              {slice.label} <span className="text-muted-foreground tabular-nums">{slice.percent}%</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (variant === 'focus') {
    const [first, ...rest] = slices;
    return (
      <div className="flex min-h-0 flex-1 items-center gap-8">
        {pie({ outerRadius: '100%' }, 'h-[150px]')}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-foreground text-xl font-medium tracking-tight text-balance">
            {t('pieFocus', { label: first!.label, percent: first!.percent })}
          </span>
          <span className="text-muted-foreground text-sm tabular-nums">
            {t('pieOfTotal', { value: format(first!.value), total: unit ? `${format(total)} ${unit}` : format(total) })}
          </span>
          <span className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 text-sm tabular-nums">
            {rest.map((slice) => (
              <span key={slice.key}>
                {slice.label} {format(slice.value)}
              </span>
            ))}
          </span>
        </div>
      </div>
    );
  }

  const ring = variant === 'ring';
  return (
    <div className="flex min-h-0 flex-1 items-center gap-8">
      <div className="relative">
        {pie(ring ? { innerRadius: '92%', outerRadius: '100%', paddingAngle: 3, strokeWidth: 0 } : { innerRadius: '68%', outerRadius: '100%' }, 'h-[170px]')}
        {ring ? centered(`${lead.percent}%`, lead.label) : centered(format(total), unit)}
      </div>
      <ul className="flex min-w-0 flex-1 flex-col text-sm">
        {slices.map((slice, i) => (
          <li
            key={slice.key}
            {...legendTarget(focus, slice.key)}
            className={cn(
              legendTarget(focus, slice.key).className,
              'flex items-center gap-2.5 px-2 py-1.5',
              ring && 'border-border rounded-none border-b last:border-0',
              ring && i > 0 && 'text-muted-foreground',
            )}
          >
            {ring ? null : dot(slice.fill)}
            <span className={cn('min-w-0 flex-1 truncate', !ring && 'text-foreground')}>{slice.label}</span>
            <span className="font-mono text-xs tabular-nums">{format(slice.value)}</span>
            {ring ? null : <span className="text-muted-foreground w-9 text-right font-mono text-xs tabular-nums">{slice.percent}%</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const withUnit = (name: string, unit: unknown) => (unit ? `${name} (${unit})` : name);

export function ChartView({ node, props }: GenuiComponentProps) {
  const t = useTranslations('genui');
  const focus = useFocus();
  const locale = useLocale();
  // A streamed pie arrives before its slices resolve (the parent line comes first). Hold its space until one lands.
  if (node.type === 'PieChart' && kids(props.slices).length === 0) return GenuiPending(node);
  const number = new Intl.NumberFormat(locale);
  const compact = new Intl.NumberFormat(locale, { notation: 'compact' });
  const format = (value: unknown) => (typeof value === 'number' ? number.format(value) : value == null ? '—' : String(value));

  // The tooltip row of `ChartTooltipContent`, with the table's number format.
  const tooltip = (
    <ChartTooltipContent
      hideLabel={node.type === 'PieChart'}
      formatter={(value, name, item) => (
        <>
          <span
            className="size-2.5 shrink-0 rounded-xs"
            style={{ backgroundColor: (item as { color?: string; payload?: { fill?: string } }).payload?.fill ?? (item as { color?: string }).color }}
          />
          <span className="flex flex-1 items-center justify-between gap-2 leading-none">
            <span className="text-muted-foreground">{name}</span>
            <span className="text-foreground font-mono font-medium tabular-nums">{format(value)}</span>
          </span>
        </>
      )}
    />
  );

  let entries: Entry[];
  let figure: React.ReactNode;

  if (node.type === 'PieChart') {
    const slices = kids(props.slices).map((slice, i) => ({
      key: `p${i}`,
      label: String(slice.props.label),
      value: Number(slice.props.value) || 0,
      fill: PIE_RAMP[i]!,
    }));
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    const percent = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0);
    entries = slices.map(({ key, label, fill }) => ({ key, label, color: fill }));
    figure = (
      <PieFigure
        variant={(props.variant as PieVariant | undefined) ?? (slices.length === 2 ? 'gauge' : 'donut')}
        slices={slices.map((slice) => ({ ...slice, percent: percent(slice.value) }))}
        total={total}
        unit={props.unit ? String(props.unit) : undefined}
        format={format}
        tooltip={tooltip}
        focus={focus}
      />
    );
  } else {
    const line = node.type === 'LineChart';
    const series: GenuiNode[] = kids(props.series);
    const labels = ((line ? props.x : props.categories) ?? []) as string[];
    entries = series.map((s, k) => ({ key: `s${k}`, label: String(s.props.name), color: PALETTE[k] }));
    // A missing value stays a gap, never a fabricated zero.
    const valueAt = (s: GenuiNode, i: number): number | null => (s.props.values as number[] | undefined)?.[i] ?? null;
    const data = labels.map((label, i) => Object.fromEntries([['label', label], ...series.map((s, k) => [`s${k}`, valueAt(s, i)])]));
    const Chart = line ? LineChart : BarChart;
    figure = (
      <Chart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barGap={2} maxBarSize={48}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={40}
          tickFormatter={(value: number) => compact.format(value)}
        />
        <ChartTooltip isAnimationActive={false} content={tooltip} />
        {entries.map(({ key, label }) =>
          line ? (
            <Line
              key={key}
              dataKey={key}
              name={label}
              stroke={`var(--color-${key})`}
              strokeWidth={2}
              strokeOpacity={dimmed(focus, key)}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--background)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ) : (
            <Bar
              key={key}
              dataKey={key}
              name={label}
              fill={`var(--color-${key})`}
              fillOpacity={dimmed(focus, key)}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          ),
        )}
      </Chart>
    );
  }

  const config: ChartConfig = Object.fromEntries(entries.map(({ key, label, color }) => [key, { label, color }]));
  const title = props.unit ? `${String(props.source)} · ${props.unit}` : String(props.source);
  return (
    <figure className={cn(CHART_FIGURE_HEIGHT, 'flex flex-col gap-2')} aria-label={genuiA11yText(node) ?? undefined}>
      {/* Header row: the source is the chart's title, on the left like a Table caption; Show data sits on the
          right. One line, full title on hover, so the plot block below starts where the pending block reserves. */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-foreground min-w-0 truncate text-sm font-medium" title={title}>
          {title}
        </span>
        <Dialog>
          <DialogTrigger asChild>
            <button type="button" className="text-muted-foreground hover:text-foreground duration-fast shrink-0 py-1 text-xs transition-colors">
              {t('showData')}
            </button>
          </DialogTrigger>
          <DialogContent className="flex max-h-[80vh] flex-col gap-4 sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('showData')}</DialogTitle>
              <DialogDescription>{title}</DialogDescription>
            </DialogHeader>
            {/* The table scrolls inside the dialog, so a 365-point series keeps the header and close button in view. */}
            <div className="min-h-0 overflow-y-auto">
              <ChartDataTable node={node} />
            </div>
          </DialogContent>
        </Dialog>
      </div>
      {/* Fixed plot block: the legend on top, under the header row; the chart takes what it leaves. The title
          names the source, not the series, so a bar or line chart names even one series in the legend. */}
      <div className="flex h-[244px] flex-col gap-3">
        {node.type !== 'PieChart' && entries.length > 0 ? (
          // No negative margin: the figure clips, so a pill pulled past its edge was cut off on hover.
          <ul className="text-muted-foreground flex flex-wrap gap-x-1 gap-y-1 text-xs">
            {entries.map(({ key, label, color }) => (
              <li key={key} {...legendTarget(focus, key)} className={cn(legendTarget(focus, key).className, 'hover:text-foreground flex items-center gap-1.5 px-1.5 py-0.5')}>
                <span className="size-2.5 shrink-0 rounded-xs" style={{ backgroundColor: color }} aria-hidden />
                {label}
              </li>
            ))}
          </ul>
        ) : null}
        {node.type === 'PieChart' ? (
          figure
        ) : (
          <ChartContainer
            config={config}
            className="[&_.recharts-bar-rectangle_path]:duration-fast [&_.recharts-line-curve]:duration-fast aspect-auto min-h-0 w-full flex-1 [&_.recharts-bar-rectangle_path]:transition-[fill-opacity] [&_.recharts-line-curve]:transition-[stroke-opacity]"
          >
            {figure}
          </ChartContainer>
        )}
      </div>
    </figure>
  );
}

/** The chart's values as text: the Show data dialog's table. A missing value stays a dash, never a zero. */
export function ChartDataTable({ node }: { node: GenuiNode }) {
  const t = useTranslations('genui');
  const number = new Intl.NumberFormat(useLocale());
  const format = (value: unknown) => (typeof value === 'number' ? number.format(value) : value == null ? '—' : String(value));
  const { props } = node;
  let head: string[];
  let rows: Cell[][];
  if (node.type === 'PieChart') {
    const slices = kids(props.slices).map((slice) => ({ label: String(slice.props.label), value: Number(slice.props.value) || 0 }));
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    head = [t('label'), t('value'), '%'];
    rows = slices.map((slice) => [slice.label, slice.value, `${total > 0 ? Math.round((slice.value / total) * 100) : 0}%`]);
  } else {
    const series = kids(props.series);
    const labels = ((node.type === 'LineChart' ? props.x : props.categories) ?? []) as string[];
    head = [t('label'), ...series.map((s) => withUnit(String(s.props.name), props.unit))];
    rows = labels.map((label, i) => [label, ...series.map((s) => (s.props.values as number[] | undefined)?.[i] ?? null)]);
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head.map((cell, c) => (
            // The label column needs no visible heading: its cells name themselves. Only the text is
            // hidden: `sr-only` on the <th> makes it absolute and shifts every header one column left.
            <TableHead key={c} className={c === 0 ? undefined : 'text-right'}>
              {c === 0 ? <span className="sr-only">{cell}</span> : cell}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, r) => (
          <TableRow key={r}>
            {row.map((cell, c) => (
              <TableCell key={c} className={cn(c > 0 && 'text-right tabular-nums')}>
                {format(cell)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default ChartView;
