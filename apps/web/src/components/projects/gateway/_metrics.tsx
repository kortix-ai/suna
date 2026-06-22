'use client';

import type { ReactNode } from 'react';
import type { Icon as LucideIcon } from '@mynaui/icons-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { cn } from '@/lib/utils';
import { useGatewayOverlayStore } from '@/stores/gateway-overlay-store';
import type { GatewaySeriesPoint } from '@/lib/projects-gateway-client';

import { tint } from './_shared';

export const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

export const chartConfig = {
  cost: { label: 'Spend', color: 'var(--chart-1)' },
  requests: { label: 'Requests', color: 'var(--chart-2)' },
  errors: { label: 'Errors', color: 'var(--chart-4)' },
  input_tokens: { label: 'Input', color: 'var(--chart-3)' },
  output_tokens: { label: 'Output', color: 'var(--chart-1)' },
  p50: { label: 'p50', color: 'var(--chart-3)' },
  p95: { label: 'p95', color: 'var(--chart-2)' },
  p99: { label: 'p99', color: 'var(--chart-4)' },
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

export function useGatewayRange() {
  const days = useGatewayOverlayStore((s) => s.days);
  const setDays = useGatewayOverlayStore((s) => s.setDays);
  return { days, setDays };
}

export function RangeSelector() {
  const { days, setDays } = useGatewayRange();
  return (
    <div className="flex items-center justify-end">
      <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card p-0.5">
        {RANGES.map((r) => (
          <button
            key={r.days}
            type="button"
            onClick={() => setDays(r.days)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              days === r.days ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniSpark({
  data,
  dataKey,
  color,
}: {
  data: Record<string, unknown>[];
  dataKey: string;
  color: string;
}) {
  return (
    <div className="h-8 w-20 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, bottom: 2 }}>
          <Area
            dataKey={dataKey}
            type="monotone"
            stroke={color}
            fill={color}
            fillOpacity={0.15}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
  spark,
  sparkKey,
  index = 0,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  accent: string;
  spark?: Record<string, unknown>[];
  sparkKey?: string;
  index?: number;
}) {
  return (
    <div
      className="group animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both rounded-2xl border border-border/60 bg-card p-4 transition-colors duration-200 hover:border-border"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div
          className="flex size-6 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-110"
          style={{ backgroundColor: tint(accent, 12), color: accent }}
        >
          <Icon className="size-3.5" />
        </div>
      </div>
      <div className="mt-1.5 truncate text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="min-h-4 text-xs text-muted-foreground">{sub ?? ''}</span>
        {spark && sparkKey && <MiniSpark data={spark} dataKey={sparkKey} color={accent} />}
      </div>
    </div>
  );
}

export function UsageChart({
  data,
  keys,
  yFormatter,
}: {
  data: GatewaySeriesPoint[];
  keys: (keyof typeof chartConfig)[];
  yFormatter?: (v: number) => string;
}) {
  return (
    <ChartContainer config={chartConfig} className="h-[200px] w-full">
      <AreaChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
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
                const cfg = chartConfig[name as keyof typeof chartConfig];
                return (
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span
                        className="size-2 rounded-sm"
                        style={{ backgroundColor: `var(--color-${String(name)})` }}
                      />
                      {cfg?.label ?? name}
                    </span>
                    <span className="font-medium tabular-nums text-foreground">
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
            fillOpacity={0.12}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

export function MeterRow({
  rank,
  accent,
  label,
  value,
  segments,
  sub,
}: {
  rank: number;
  accent: string;
  label: ReactNode;
  value: ReactNode;
  segments: { pct: number; color: string }[];
  sub?: ReactNode;
}) {
  return (
    <div className="group -mx-2 rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-muted/40">
      <div className="flex items-center gap-3">
        <span className="w-3 shrink-0 text-right text-xs tabular-nums text-muted-foreground/40">{rank}</span>
        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">{label}</span>
        <div className="flex h-1 w-20 shrink-0 overflow-hidden rounded-full bg-foreground/[0.07] sm:w-32">
          {segments.map((s, i) => (
            <div
              key={i}
              className="h-full transition-[width] duration-700 ease-out"
              style={{ width: `${Math.max(0, Math.min(100, s.pct))}%`, backgroundColor: s.color }}
            />
          ))}
        </div>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      {sub && <div className="mt-1 flex items-center gap-3 pl-7 text-xs tabular-nums text-muted-foreground/60">{sub}</div>}
    </div>
  );
}
