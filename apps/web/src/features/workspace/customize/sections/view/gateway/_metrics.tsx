'use client';

import type { ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import type { GatewaySeriesPoint } from '@/lib/projects-gateway-client';
import { cn } from '@/lib/utils';

export const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

// Monochrome + one accent: kortix-blue carries the signal, neutrals carry the
// secondary series, red is only ever "errors". No yellow/amber/brown chart ramp.
export const chartConfig = {
  cost: { label: 'Spend', color: 'var(--kortix-blue)' },
  requests: { label: 'Requests', color: 'var(--kortix-blue)' },
  errors: { label: 'Errors', color: 'var(--destructive)' },
  input_tokens: { label: 'Input', color: 'var(--kortix-blue)' },
  output_tokens: { label: 'Output', color: 'var(--muted-foreground)' },
  p50: { label: 'p50', color: 'var(--muted-foreground)' },
  p95: {
    label: 'p95',
    color: 'color-mix(in oklch, var(--kortix-blue) 55%, var(--muted-foreground))',
  },
  p99: { label: 'p99', color: 'var(--kortix-blue)' },
} satisfies ChartConfig;

export function fmtDay(value: string): string {
  const d = new Date(`${value}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Milliseconds as the latency tab reads them: `840ms`, `2.8s`. */
export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * The window's latency as one number: each day's p50, weighted by that day's
 * requests. The gateway reports percentiles per day only, so this is an
 * average of daily medians — the headline, not a true window median.
 */
export function weightedP50(series: readonly GatewaySeriesPoint[]): number | null {
  let weight = 0;
  let total = 0;
  for (const point of series) {
    if (point.requests <= 0 || !Number.isFinite(point.p50)) continue;
    weight += point.requests;
    total += point.p50 * point.requests;
  }
  return weight > 0 ? total / weight : null;
}

export function RangeSelector({
  days,
  setDays,
  className,
}: {
  days: number;
  setDays: (days: number) => void;
  className?: string;
}) {
  const ranges = useLocalizedUiCatalog(RANGES);
  return (
    <Tabs value={String(days)} onValueChange={(next) => setDays(Number(next))} className={className}>
      <TabsList size="xs">
        {ranges.map((r) => (
          <TabsTrigger key={r.days} value={String(r.days)} size="xs" className="tabular-nums">
            {r.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * One metric in the chart card's header: its name and its total for the
 * window. Selecting it swaps the chart below. Cells after the first carry a
 * hairline on their left; the selected one a 2px foreground rule on its
 * bottom edge.
 */
export function MetricTab({
  label,
  value,
  selected,
  onSelect,
}: {
  label: string;
  value: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'border-border flex min-w-0 flex-1 basis-0 flex-col items-start gap-1 border-b-2 border-l px-5 py-4 text-left first:border-l-0',
        'transition-[border-color,background-color] duration-(--duration-normal) ease-out',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2 focus-visible:ring-inset',
        selected ? 'border-b-foreground' : 'hover:bg-muted border-b-transparent',
      )}
    >
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={cn(
          'truncate text-xl font-semibold tracking-tight tabular-nums',
          selected ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {value}
      </span>
    </button>
  );
}

export function UsageChart({
  data,
  keys,
  yFormatter,
  className,
}: {
  data: GatewaySeriesPoint[];
  keys: (keyof typeof chartConfig)[];
  yFormatter?: (v: number) => string;
  className?: string;
}) {
  const localizedChartConfig = useLocalizedUiCatalog(chartConfig);
  return (
    <ChartContainer config={localizedChartConfig} className={cn('h-72 w-full', className)}>
      <AreaChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={28}
          tickFormatter={fmtDay}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(l) => fmtDay(String(l))}
              formatter={(value, name) => {
                const num = Number(value);
                const cfg = localizedChartConfig[name as keyof typeof chartConfig];
                return (
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-sm"
                        style={{ backgroundColor: `var(--color-${String(name)})` }}
                      />
                      {cfg?.label ?? name}
                    </span>
                    <span className="text-foreground font-medium tabular-nums">
                      {yFormatter ? yFormatter(num) : num.toLocaleString()}
                    </span>
                  </span>
                );
              }}
            />
          }
        />
        {keys.map((k) => (
          <Area
            key={k}
            dataKey={k}
            type="monotone"
            stackId={keys.length > 1 ? 'a' : undefined}
            stroke={`var(--color-${k})`}
            fill={`var(--color-${k})`}
            fillOpacity={0.1}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

/**
 * One section of the Costs page: a title row (title, one line of description,
 * an action or a figure on the right) over its own bordered panel.
 */
export function CostSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-1 basis-0 flex-col gap-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-foreground text-sm font-medium">{title}</h3>
          {description ? (
            <p className="text-muted-foreground text-xs text-pretty">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The bordered panel under a section's title row. */
export function CostPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn('border-border bg-surface flex flex-col rounded-md border px-4 py-1', className)}
    >
      {children}
    </div>
  );
}

/** A share bar: segments stack left to right on a muted track. */
export function ShareBar({
  segments,
  className,
}: {
  segments: { pct: number; color: string }[];
  className?: string;
}) {
  return (
    <div className={cn('bg-muted flex h-1 shrink-0 overflow-hidden rounded-xs', className)}>
      {segments.map((s, i) => (
        <div
          key={i}
          className="h-full"
          style={{ width: `${Math.max(0, Math.min(100, s.pct))}%`, backgroundColor: s.color }}
        />
      ))}
    </div>
  );
}
