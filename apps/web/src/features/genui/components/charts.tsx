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
 *   series in ink and the Show data table carries every value as text.
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
import { CaretRightIcon } from '@phosphor-icons/react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts';

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import type { GenuiComponentProps, GenuiNode } from '../sdk';
import { kids } from './layout';
import { CHART_FIGURE_HEIGHT } from './pending';

const PALETTE = ['var(--chart-3)', 'var(--chart-5)', 'var(--foreground)', 'var(--chart-1)', 'var(--chart-4)', 'var(--chart-2)'];

type Entry = { key: string; label: string; color: string };
type Cell = string | number | null;

const withUnit = (name: string, unit: unknown) => (unit ? `${name} (${unit})` : name);

export function ChartView({ node, props }: GenuiComponentProps) {
  const t = useTranslations('genui');
  const locale = useLocale();
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
  let head: string[];
  let rows: Cell[][];
  let figure: React.ReactNode;

  if (node.type === 'PieChart') {
    const slices = kids(props.slices).map((slice, i) => ({
      key: `p${i}`,
      label: String(slice.props.label),
      value: Number(slice.props.value) || 0,
      fill: PALETTE[i],
    }));
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    entries = slices.map(({ key, label, fill }) => ({ key, label, color: fill }));
    head = [t('label'), t('value'), '%'];
    rows = slices.map((slice) => [slice.label, slice.value, `${total > 0 ? Math.round((slice.value / total) * 100) : 0}%`]);
    figure = (
      <PieChart>
        <ChartTooltip isAnimationActive={false} content={tooltip} />
        <Pie data={slices} dataKey="value" nameKey="label" innerRadius="55%" stroke="var(--background)" strokeWidth={2} isAnimationActive={false} />
      </PieChart>
    );
  } else {
    const line = node.type === 'LineChart';
    const series: GenuiNode[] = kids(props.series);
    const labels = ((line ? props.x : props.categories) ?? []) as string[];
    entries = series.map((s, k) => ({ key: `s${k}`, label: String(s.props.name), color: PALETTE[k] }));
    head = [t('label'), ...entries.map((entry) => withUnit(entry.label, props.unit))];
    // A missing value stays a gap, never a fabricated zero.
    const valueAt = (s: GenuiNode, i: number): number | null => (s.props.values as number[] | undefined)?.[i] ?? null;
    rows = labels.map((label, i) => [label, ...series.map((s) => valueAt(s, i))]);
    const data = labels.map((label, i) => Object.fromEntries([['label', label], ...series.map((s, k) => [`s${k}`, valueAt(s, i)])]));
    const Chart = line ? LineChart : BarChart;
    figure = (
      <Chart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barGap={2} maxBarSize={48}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={40} tickFormatter={(value: number) => compact.format(value)} />
        <ChartTooltip isAnimationActive={false} content={tooltip} />
        {entries.map(({ key, label }) =>
          line ? (
            <Line
              key={key}
              dataKey={key}
              name={label}
              stroke={`var(--color-${key})`}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--background)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ) : (
            <Bar key={key} dataKey={key} name={label} fill={`var(--color-${key})`} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          ),
        )}
      </Chart>
    );
  }

  const config: ChartConfig = Object.fromEntries(entries.map(({ key, label, color }) => [key, { label, color }]));
  const source = t('source', { source: String(props.source) });
  return (
    <figure className={cn(CHART_FIGURE_HEIGHT, 'flex flex-col gap-2')} aria-label={genuiA11yText(node) ?? undefined}>
      {/* Fixed plot block: the chart takes what the legend leaves (220px under a one-line legend). */}
      <div className="flex h-[244px] flex-col gap-2">
        {entries.length > 1 ? (
          <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {entries.map(({ key, label, color }) => (
              <li key={key} className="flex items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-xs" style={{ backgroundColor: color }} aria-hidden />
                {label}
              </li>
            ))}
          </ul>
        ) : null}
        <ChartContainer config={config} className="aspect-auto min-h-0 w-full flex-1">
          {figure}
        </ChartContainer>
      </div>
      <figcaption className="text-muted-foreground text-xs text-pretty">{props.unit ? `${source} · ${props.unit}` : source}</figcaption>
      <details className="group">
        <summary className="text-muted-foreground hover:text-foreground duration-fast flex w-fit list-none items-center gap-1 py-1 text-xs transition-colors [&::-webkit-details-marker]:hidden">
          <CaretRightIcon className="duration-moderate size-3 shrink-0 transition-transform ease-out group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
          {t('showData')}
        </summary>
        <div className="mt-1">
          <Table>
            <TableHeader>
              <TableRow>
                {head.map((cell, c) => (
                  // The label column needs no visible heading: its cells name themselves.
                  <TableHead key={c} className={cn(c === 0 ? 'sr-only' : 'text-right')}>
                    {cell}
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
        </div>
      </details>
    </figure>
  );
}

export default ChartView;
