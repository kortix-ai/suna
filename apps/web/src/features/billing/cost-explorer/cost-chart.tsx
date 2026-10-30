'use client';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import type { CostSeriesPoint } from '@kortix/sdk';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@kortix/ui/chart';
import { Skeleton } from '@kortix/ui/skeleton';
import { useLocalizedUiCatalog } from '@kortix/ui/i18n';

import { formatSessionCostCredits } from '@kortix/ui/internal/billing/session-cost-format';

// Monochrome + one accent per the Kortix palette law: llm_cost and
// compute_cost are two shades of the same warm chart ramp (--chart-1 /
// --chart-2), not two unrelated colours competing for attention.
const chartConfig = {
  llm_cost: { label: 'LLM', color: 'var(--chart-1)' },
  compute_cost: { label: 'Compute', color: 'var(--chart-2)' },
} satisfies ChartConfig;

function formatDay(value: string, locale = 'en-US'): string {
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A Y-axis tick, in credits, from a USD value. Compact from 10,000 credits
 *  up (`12K`): the axis is 48px wide and a grouped five-digit tick clips. */
export function formatAxisCredits(usd: number, locale = 'en-US'): string {
  const credits = usd * 100;
  if (Math.abs(credits) >= 10_000) {
    return credits.toLocaleString(locale, { notation: 'compact', maximumFractionDigits: 1 });
  }
  return formatSessionCostCredits(usd, locale);
}

export interface CostChartProps {
  series: CostSeriesPoint[];
  isLoading: boolean;
}

export function CostChart({ series, isLoading }: CostChartProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const localizedChartConfig = useLocalizedUiCatalog(chartConfig);
  if (isLoading) {
    // Skeleton only forwards `className`/`children` (see
    // packages/ui/src/primitives/skeleton.tsx), not arbitrary DOM props, so the label goes
    // on a wrapping element — the same shape CostSummaryTiles' loading state
    // uses for its own aria-label.
    return (
      <div aria-label={tI18nComplete.raw('text5ca55f86beaf')}>
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
    <ChartContainer config={localizedChartConfig} className="h-[220px] w-full">
      <BarChart accessibilityLayer data={series} margin={{ left: 4, right: 8, top: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value) => formatDay(value, locale)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
          tickFormatter={(value: number) => formatAxisCredits(value, locale)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => formatDay(String(value), locale)}
              formatter={(value, name) => {
                const cfg = localizedChartConfig[name as keyof typeof localizedChartConfig];
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
                      {formatSessionCostCredits(Number(value), locale)}
                    </span>
                  </span>
                );
              }}
            />
          }
        />
        <Bar dataKey="llm_cost" stackId="cost" fill="var(--color-llm_cost)" />
        <Bar
          dataKey="compute_cost"
          stackId="cost"
          fill="var(--color-compute_cost)"
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}
