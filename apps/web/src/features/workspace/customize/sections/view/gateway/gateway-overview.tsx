'use client';

import {
  WarningIcon as AlertTriangle,
  CoinsIcon as Coins,
  CpuIcon as Cpu,
  CurrencyDollarIcon as DollarSign,
  SparkleIcon as Sparkles,
  LightningIcon as Zap,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import {
  useGatewayBreakdown,
  useGatewayErrors,
  useGatewayOverview,
  useGatewaySeries,
  useGatewaySessions,
} from '@/hooks/projects/use-project-gateway';
import { listProjectSessions } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

import {
  MeterRow,
  RangeSelector,
  StatCard,
  UsageChart,
  chartConfig,
  fmtCompact,
  fmtUsd,
} from './_metrics';
import { Panel, displayModel, modelAccent } from './_shared';
import { GatewayBudgetSection } from './gateway-budgets';

type MetricKey = 'cost' | 'traffic' | 'tokens' | 'latency';

const METRICS: {
  key: MetricKey;
  label: string;
  keys: (keyof typeof chartConfig)[];
  fmt: (v: number) => string;
}[] = [
  { key: 'cost', label: 'Spend', keys: ['cost'], fmt: fmtUsd },
  {
    key: 'traffic',
    label: 'Requests',
    keys: ['requests', 'errors'],
    fmt: (v) => v.toLocaleString(),
  },
  { key: 'tokens', label: 'Tokens', keys: ['input_tokens', 'output_tokens'], fmt: fmtCompact },
  {
    key: 'latency',
    label: 'Latency',
    keys: ['p50', 'p95', 'p99'],
    fmt: (v) => `${fmtCompact(v)}ms`,
  },
];

/**
 * The gateway dashboard — one scannable analytics surface that folds the former
 * Overview, Cost, Usage and Budgets tabs together: headline stats, the spend
 * cap that governs them, a single chart you pivot across metrics, and the
 * spend/error breakdowns underneath.
 *
 * Budgets used to be the tab next door, and it opened by restating this
 * screen's "Total spend" figure in its own 2xl type. Reading a number and
 * capping it are one job; the cap now sits directly under the number
 * (`GatewayBudgetSection`), before the trend chart, because a limit is a
 * setting about the headline and not a footnote to the breakdowns.
 */
export function GatewayOverview({
  projectId,
  canWrite = false,
}: {
  projectId: string;
  /** Gates the budget controls. Read-only members still see the cap. */
  canWrite?: boolean;
}) {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<MetricKey>('cost');

  const { data: overview } = useGatewayOverview(projectId, days);
  const { data: seriesData } = useGatewaySeries(projectId, days);
  const { data: breakdown } = useGatewayBreakdown(projectId, days);
  const { data: sessionsData } = useGatewaySessions(projectId, days);
  const { data: errorData } = useGatewayErrors(projectId, days);

  // Resolve session ids → human names so spend reads as "Fix login bug", not a
  // raw uuid. Map both the kortix and opencode ids since the gateway may key on
  // either.
  const { data: projectSessions } = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId),
    enabled: !!projectId,
    ...contract('inventory'),
  });
  const sessionNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of projectSessions ?? []) {
      const label = s.name ?? s.custom_name ?? null;
      if (!label) continue;
      m.set(s.session_id, label);
      if (s.opencode_session_id) m.set(s.opencode_session_id, label);
    }
    return m;
  }, [projectSessions]);

  const requests = overview?.requests ?? 0;
  const errors = overview?.errors ?? 0;
  const cost = overview?.total_cost ?? 0;
  const inTokens = overview?.input_tokens ?? 0;
  const outTokens = overview?.output_tokens ?? 0;

  const series = seriesData?.series ?? [];
  const sparkSeries = series.map((s) => ({ ...s, tokens: s.input_tokens + s.output_tokens }));

  const models = [...(breakdown?.models ?? [])].sort((a, b) => b.cost - a.cost).slice(0, 6);
  const maxModelCost = Math.max(1e-9, ...models.map((m) => m.cost));
  const sessions = sessionsData?.sessions ?? [];
  const maxSessionCost = Math.max(1e-9, ...sessions.map((s) => s.total_cost));
  const errorTypes = errorData?.errors ?? [];
  const maxErrorCount = Math.max(1, ...errorTypes.map((e) => e.count));

  const activeMetric = METRICS.find((m) => m.key === metric) ?? METRICS[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="w-full space-y-5 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-foreground text-sm font-medium">Last {days} days</h2>
          <RangeSelector days={days} setDays={setDays} />
        </div>

        {/* Headline stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Total spend"
            value={fmtUsd(cost)}
            sub={`over ${days} days`}
            icon={DollarSign}
            accent="var(--kortix-blue)"
            spark={sparkSeries}
            sparkKey="cost"
            index={0}
          />
          <StatCard
            label="Requests"
            value={requests.toLocaleString()}
            sub={`${(requests / Math.max(1, days)).toFixed(0)}/day avg`}
            icon={Zap}
            accent="var(--kortix-blue)"
            spark={sparkSeries}
            sparkKey="requests"
            index={1}
          />
          <StatCard
            label="Errors"
            value={errors.toLocaleString()}
            sub={
              requests ? `${((errors / requests) * 100).toFixed(1)}% error rate` : 'no requests yet'
            }
            icon={AlertTriangle}
            accent="var(--destructive)"
            spark={sparkSeries}
            sparkKey="errors"
            index={2}
          />
          <StatCard
            label="Tokens"
            value={fmtCompact(inTokens + outTokens)}
            sub={`${fmtCompact(inTokens)} in · ${fmtCompact(outTokens)} out`}
            icon={Coins}
            accent="var(--kortix-blue)"
            spark={sparkSeries}
            sparkKey="tokens"
            index={3}
          />
        </div>

        {/* The cap on the figure directly above it — the whole former Budgets
            tab, as one panel. */}
        <GatewayBudgetSection projectId={projectId} canWrite={canWrite} />

        {/* One chart, pivoted across metrics */}
        <Panel
          title="Trend"
          description="Daily gateway traffic across the window"
          action={
            <FilterBar className="h-8">
              {METRICS.map((m) => (
                <FilterBarItem
                  key={m.key}
                  onClick={() => setMetric(m.key)}
                  data-state={metric === m.key ? 'active' : 'inactive'}
                  className="text-xs"
                >
                  {m.label}
                </FilterBarItem>
              ))}
            </FilterBar>
          }
        >
          <UsageChart data={series} keys={activeMetric.keys} yFormatter={activeMetric.fmt} />
        </Panel>

        {/* Breakdowns */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Top models" count={models.length} description="Spend by model">
            {models.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">No requests yet.</p>
            ) : (
              <div className="space-y-0.5">
                {models.map((m, i) => {
                  const accent = modelAccent(`${m.provider}/${m.model}`);
                  return (
                    <MeterRow
                      key={`${m.provider}/${m.model}`}
                      rank={i + 1}
                      accent={accent}
                      label={displayModel(m.model) || 'unknown'}
                      value={<span className="text-foreground font-medium">{fmtUsd(m.cost)}</span>}
                      segments={[{ pct: (m.cost / maxModelCost) * 100, color: accent }]}
                    />
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel
            title="Top sessions"
            count={sessions.length}
            description="Total cost — LLM + sandbox compute"
          >
            {sessions.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">No sessions yet.</p>
            ) : (
              <div className="space-y-0.5">
                {sessions.slice(0, 6).map((s, i) => {
                  const name = sessionNames.get(s.session_id);
                  return (
                    <MeterRow
                      key={s.session_id}
                      rank={i + 1}
                      accent={modelAccent(s.session_id)}
                      label={
                        name ? <span className="font-sans">{name}</span> : s.session_id.slice(0, 8)
                      }
                      value={
                        <span className="text-foreground font-semibold">
                          {fmtUsd(s.total_cost)}
                        </span>
                      }
                      sub={
                        <>
                          {name && (
                            <span className="text-muted-foreground/40 font-mono">
                              {s.session_id.slice(0, 8)}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Sparkles className="text-kortix-blue size-3" />
                            {fmtUsd(s.llm_cost)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Cpu className="text-muted-foreground size-3" />
                            {fmtUsd(s.compute_cost)}
                          </span>
                          <span className="text-muted-foreground/50">
                            {s.requests.toLocaleString()} req
                          </span>
                        </>
                      }
                      segments={[
                        { pct: (s.llm_cost / maxSessionCost) * 100, color: 'var(--kortix-blue)' },
                        {
                          pct: (s.compute_cost / maxSessionCost) * 100,
                          color: 'var(--muted-foreground)',
                        },
                      ]}
                    />
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        {errorTypes.length > 0 && (
          <Panel
            title="Errors by type"
            count={errorTypes.length}
            description="What's failing across this window"
          >
            <div className="space-y-0.5">
              {errorTypes.map((e, i) => (
                <MeterRow
                  key={e.code}
                  rank={i + 1}
                  accent="var(--destructive)"
                  label={e.code}
                  value={e.count.toLocaleString()}
                  segments={[{ pct: (e.count / maxErrorCount) * 100, color: 'var(--destructive)' }]}
                />
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
