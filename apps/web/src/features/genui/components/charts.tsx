'use client';

/**
 * Bar, line and pie charts for generative UI. `index.tsx` loads this module
 * through `lazy()`, so recharts and the `@kortix/sdk/genui` barrel load with
 * the first chart, not with every reply.
 *
 * COLOR (dataviz validator, both themes): `--chart-1..5` is the brand's one
 * data-viz ramp, a sequential warm ramp, theme-invariant. Adjacent steps are
 * too close for categories (ΔE 11.1, floor 15), so series take the most
 * separated steps first: 3, 5, 1. The fourth is neutral ink, which separates
 * from every ramp step (worst pair ΔE 14.0 light, 16.9 dark) and keeps the
 * chart monochrome-first. Pie slices 5 and 6 fall back to the in-between steps.
 * The legend names every series in ink, slices sit on a 2px surface gap, and
 * the Show data table carries every value as text, so color is never the only
 * carrier. Single series: `--chart-3`, as in admin analytics.
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

const PALETTE = ['var(--chart-3)', 'var(--chart-5)', 'var(--chart-1)', 'var(--muted-foreground)', 'var(--chart-2)', 'var(--chart-4)'];

type Entry = { key: string; label: string; color: string };
type Cell = string | number | null;

const withUnit = (name: string, unit: unknown) => (unit ? `${name} (${unit})` : name);

export function ChartView({ node, props }: GenuiComponentProps) {
  const t = useTranslations('genui');
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  const compact = new Intl.NumberFormat(locale, { notation: 'compact' });
  const format = (value: Cell) => (typeof value === 'number' ? number.format(value) : (value ?? '—'));

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
    head = ['', props.unit ? String(props.unit) : '', '%'];
    rows = slices.map((slice) => [slice.label, slice.value, `${total > 0 ? Math.round((slice.value / total) * 100) : 0}%`]);
    figure = (
      <PieChart>
        <ChartTooltip isAnimationActive={false} content={<ChartTooltipContent nameKey="label" hideLabel />} />
        <Pie data={slices} dataKey="value" nameKey="label" innerRadius="55%" stroke="var(--background)" strokeWidth={2} isAnimationActive={false} />
      </PieChart>
    );
  } else {
    const line = node.type === 'LineChart';
    const series: GenuiNode[] = kids(props.series);
    const labels = ((line ? props.x : props.categories) ?? []) as string[];
    entries = series.map((s, k) => ({ key: `s${k}`, label: withUnit(String(s.props.name), props.unit), color: PALETTE[k] }));
    head = ['', ...entries.map((entry) => entry.label)];
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
        <ChartTooltip isAnimationActive={false} content={<ChartTooltipContent indicator={line ? 'line' : 'dot'} />} />
        {entries.map(({ key }) =>
          line ? (
            <Line
              key={key}
              dataKey={key}
              stroke={`var(--color-${key})`}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--background)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ) : (
            <Bar key={key} dataKey={key} fill={`var(--color-${key})`} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          ),
        )}
      </Chart>
    );
  }

  const config: ChartConfig = Object.fromEntries(entries.map(({ key, label, color }) => [key, { label, color }]));
  return (
    <figure className="flex flex-col gap-2" aria-label={genuiA11yText(node) ?? undefined}>
      <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {entries.map(({ key, label, color }) => (
          <li key={key} className="flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-xs" style={{ backgroundColor: color }} aria-hidden />
            {label}
          </li>
        ))}
      </ul>
      <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
        {figure}
      </ChartContainer>
      <figcaption className="text-muted-foreground text-xs text-pretty">{t('source', { source: String(props.source) })}</figcaption>
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
                <TableHead key={c} className={cn(c > 0 && 'text-right')}>
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
