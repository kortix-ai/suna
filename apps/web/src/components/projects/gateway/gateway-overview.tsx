'use client';

import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Coins, DollarSign, Zap } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { SectionCard } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';
import { modelAccent, tint } from './_shared';
import type { GatewaySeriesPoint } from '@/lib/projects-gateway-client';
import {
  useGatewayBreakdown,
  useGatewayErrors,
  useGatewayOverview,
  useGatewaySeries,
  useGatewaySessions,
} from '@/hooks/projects/use-project-gateway';

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

const chartConfig = {
  cost: { label: 'Spend', color: 'var(--chart-1)' },
  requests: { label: 'Requests', color: 'var(--chart-2)' },
  errors: { label: 'Errors', color: 'var(--chart-4)' },
  input_tokens: { label: 'Input', color: 'var(--chart-3)' },
  output_tokens: { label: 'Output', color: 'var(--chart-1)' },
  p50: { label: 'p50', color: 'var(--chart-3)' },
  p95: { label: 'p95', color: 'var(--chart-2)' },
  p99: { label: 'p99', color: 'var(--chart-4)' },
} satisfies ChartConfig;

function fmtDay(value: string): string {
  const d = new Date(`${value}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
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

function StatCard({
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

function UsageChart({
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

export function GatewayOverview({ projectId }: { projectId: string }) {
  const [days, setDays] = useState(30);
  const { data: overview } = useGatewayOverview(projectId, days);
  const { data: seriesData } = useGatewaySeries(projectId, days);
  const { data: breakdown } = useGatewayBreakdown(projectId, days);
  const { data: sessionsData } = useGatewaySessions(projectId, days);
  const { data: errorData } = useGatewayErrors(projectId, days);

  const requests = overview?.requests ?? 0;
  const errors = overview?.errors ?? 0;
  const cost = overview?.total_cost ?? 0;
  const inTokens = overview?.input_tokens ?? 0;
  const outTokens = overview?.output_tokens ?? 0;

  const series = seriesData?.series ?? [];
  const sparkSeries = series.map((s) => ({ ...s, tokens: s.input_tokens + s.output_tokens }));
  const models = breakdown?.models ?? [];
  const maxModelRequests = Math.max(1, ...models.map((m) => m.requests));
  const sessions = sessionsData?.sessions ?? [];
  const maxSessionCost = Math.max(0.000001, ...sessions.map((s) => s.cost));
  const errorTypes = errorData?.errors ?? [];
  const maxErrorCount = Math.max(1, ...errorTypes.map((e) => e.count));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-5">
        <div className="flex items-center justify-end">
          <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                onClick={() => setDays(r.days)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  days === r.days
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Total spend"
            value={fmtUsd(cost)}
            sub={`last ${days} days`}
            icon={DollarSign}
            accent="var(--chart-1)"
            spark={sparkSeries}
            sparkKey="cost"
            index={0}
          />
          <StatCard
            label="Requests"
            value={requests.toLocaleString()}
            sub={`${days} day window`}
            icon={Zap}
            accent="var(--chart-2)"
            spark={sparkSeries}
            sparkKey="requests"
            index={1}
          />
          <StatCard
            label="Errors"
            value={errors.toLocaleString()}
            sub={requests ? `${((errors / requests) * 100).toFixed(1)}% error rate` : 'no requests yet'}
            icon={AlertTriangle}
            accent="var(--chart-4)"
            spark={sparkSeries}
            sparkKey="errors"
            index={2}
          />
          <StatCard
            label="Tokens"
            value={fmtCompact(inTokens + outTokens)}
            sub={`${fmtCompact(inTokens)} in · ${fmtCompact(outTokens)} out`}
            icon={Coins}
            accent="var(--chart-3)"
            spark={sparkSeries}
            sparkKey="tokens"
            index={3}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Spend" description="Daily cost routed through the gateway">
            <UsageChart data={series} keys={['cost']} yFormatter={fmtUsd} />
          </SectionCard>
          <SectionCard title="Requests" description="Successful requests and errors per day">
            <UsageChart data={series} keys={['requests', 'errors']} yFormatter={(v) => v.toLocaleString()} />
          </SectionCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Tokens" description="Input and output tokens per day">
            <UsageChart data={series} keys={['input_tokens', 'output_tokens']} yFormatter={fmtCompact} />
          </SectionCard>
          <SectionCard title="Latency" description="Response time percentiles per day (ms)">
            <UsageChart data={series} keys={['p50', 'p95', 'p99']} yFormatter={(v) => `${fmtCompact(v)}ms`} />
          </SectionCard>
        </div>

        {errorTypes.length > 0 && (
          <SectionCard
            title="Errors by type"
            count={errorTypes.length}
            description="What's failing across this window"
          >
            <div className="space-y-3">
              {errorTypes.map((e) => (
                <div key={e.code} className="min-w-0">
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="size-1.5 shrink-0 rounded-full bg-kortix-orange" />
                      <span className="truncate font-mono text-xs text-foreground">{e.code}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                      {e.count.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-primary/[0.06]">
                    <div
                      className="h-full rounded-full bg-kortix-orange transition-[width] duration-700 ease-out"
                      style={{ width: `${(e.count / maxErrorCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        <SectionCard
          title="Top models"
          count={models.length}
          description="Most-used models across this window"
        >
          {models.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No requests yet.</div>
          ) : (
            <div className="space-y-3">
              {models.map((m, i) => {
                const accent = modelAccent(`${m.provider}/${m.model}`);
                return (
                  <div key={`${m.provider}/${m.model}`} className="min-w-0">
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="flex size-5 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums"
                          style={{ backgroundColor: tint(accent, 14), color: accent }}
                        >
                          {i + 1}
                        </span>
                        <span className="truncate font-mono text-xs text-foreground">{m.model}</span>
                      </div>
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                        {m.requests.toLocaleString()} req · {fmtUsd(m.cost)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-primary/[0.06]">
                      <div
                        className="h-full rounded-full transition-[width] duration-700 ease-out"
                        style={{ width: `${(m.requests / maxModelRequests) * 100}%`, backgroundColor: accent }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Top sessions"
          count={sessions.length}
          description="Highest-spend sessions across this window"
        >
          {sessions.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No sessions yet.</div>
          ) : (
            <div className="space-y-3">
              {sessions.map((s, i) => {
                const accent = modelAccent(s.session_id);
                return (
                  <div key={s.session_id} className="min-w-0">
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="flex size-5 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums"
                          style={{ backgroundColor: tint(accent, 14), color: accent }}
                        >
                          {i + 1}
                        </span>
                        <span className="truncate font-mono text-xs text-foreground">
                          {s.session_id.slice(0, 8)}
                        </span>
                      </div>
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                        {s.requests.toLocaleString()} req · {s.models} model{s.models === 1 ? '' : 's'} ·{' '}
                        {fmtUsd(s.cost)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-primary/[0.06]">
                      <div
                        className="h-full rounded-full transition-[width] duration-700 ease-out"
                        style={{ width: `${(s.cost / maxSessionCost) * 100}%`, backgroundColor: accent }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
