'use client';

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import type { CostSeriesPoint } from '@kortix/sdk';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';

import { formatSessionCostUsd } from '../session-cost-format';

// Monochrome + one accent per the dosco palette law: llm_cost and
// compute_cost are two shades of the same warm chart ramp (--chart-1 /
// --chart-2), not two unrelated colours competing for attention.
const chartConfig = {
  llm_cost: { label: 'LLM', color: 'var(--chart-1)' },
  compute_cost: { label: 'Compute', color: 'var(--chart-2)' },
} satisfies ChartConfig;

function formatDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatAxisUsd(value: number): string {
  if (value === 0) return '$0';
  if (value >= 1) return `$${Math.round(value).toLocaleString('en-US')}`;
  return formatSessionCostUsd(value);
}

export interface CostChartProps {
  series: CostSeriesPoint[];
  isLoading: boolean;
}

export function CostChart({ series, isLoading }: CostChartProps) {
  if (isLoading) {
    // Skeleton only forwards `className`/`children` (see
    // components/ui/skeleton.tsx), not arbitrary DOM props, so the label goes
    // on a wrapping element — the same shape CostSummaryTiles' loading state
    // uses for its own aria-label.
    return (
      <div aria-label="Loading spend chart">
        <Skeleton className="h-[220px] w-full rounded-md" />
      </div>
    );
  }

  // A one-bar chart is noise pretending to be information — render nothing
  // below two points rather than a single meaningless column.
  if (series.length < 2) {
    return null;
  }

  return (
    <ChartContainer config={chartConfig} className="h-[220px] w-full">
      <BarChart accessibilityLayer data={series} margin={{ left: 4, right: 8, top: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatDay}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
          tickFormatter={formatAxisUsd}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => formatDay(String(value))}
              formatter={(value, name) => {
                const cfg = chartConfig[name as keyof typeof chartConfig];
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
                      {formatSessionCostUsd(Number(value))}
                    </span>
                  </span>
                );
              }}
            />
          }
        />
        <Bar dataKey="llm_cost" stackId="cost" fill="var(--color-llm_cost)" />
        <Bar dataKey="compute_cost" stackId="cost" fill="var(--color-compute_cost)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
