'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Coins, Cpu, DollarSign, Sparkles, Zap } from 'lucide-react';

import { SectionCard } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';
import { listProjectSessions } from '@/lib/projects-client';
import {
  useGatewayBreakdown,
  useGatewayErrors,
  useGatewayOverview,
  useGatewaySeries,
  useGatewaySessions,
} from '@/hooks/projects/use-project-gateway';

import { displayModel, modelAccent } from './_shared';
import {
  MeterRow,
  RangeSelector,
  StatCard,
  UsageChart,
  chartConfig,
  fmtCompact,
  fmtUsd,
} from './_metrics';

type MetricKey = 'cost' | 'traffic' | 'tokens' | 'latency';

const METRICS: {
  key: MetricKey;
  label: string;
  keys: (keyof typeof chartConfig)[];
  fmt: (v: number) => string;
}[] = [
  { key: 'cost', label: 'Spend', keys: ['cost'], fmt: fmtUsd },
  { key: 'traffic', label: 'Requests', keys: ['requests', 'errors'], fmt: (v) => v.toLocaleString() },
  { key: 'tokens', label: 'Tokens', keys: ['input_tokens', 'output_tokens'], fmt: fmtCompact },
  { key: 'latency', label: 'Latency', keys: ['p50', 'p95', 'p99'], fmt: (v) => `${fmtCompact(v)}ms` },
];

/**
 * The gateway dashboard — one scannable analytics surface that folds the former
 * Overview, Cost and Usage tabs together: headline stats, a single chart you
 * pivot across metrics, and the spend/error breakdowns underneath.
 */
export function GatewayOverview({ projectId }: { projectId: string }) {
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
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
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
          <h2 className="text-sm font-medium text-foreground">Last {days} days</h2>
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
            sub={requests ? `${((errors / requests) * 100).toFixed(1)}% error rate` : 'no requests yet'}
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

        {/* One chart, pivoted across metrics */}
        <SectionCard
          title="Trend"
          description="Daily gateway traffic across the window"
          action={
            <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card p-0.5">
              {METRICS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMetric(m.key)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                    metric === m.key
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          }
        >
          <UsageChart data={series} keys={activeMetric.keys} yFormatter={activeMetric.fmt} />
        </SectionCard>

        {/* Breakdowns */}
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Top models" count={models.length} description="Spend by model">
            {models.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No requests yet.</p>
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
                      value={<span className="font-medium text-foreground">{fmtUsd(m.cost)}</span>}
                      segments={[{ pct: (m.cost / maxModelCost) * 100, color: accent }]}
                    />
                  );
                })}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Top sessions"
            count={sessions.length}
            description="Total cost — LLM + sandbox compute"
          >
            {sessions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No sessions yet.</p>
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
                        name ? (
                          <span className="font-sans">{name}</span>
                        ) : (
                          s.session_id.slice(0, 8)
                        )
                      }
                      value={
                        <span className="font-semibold text-foreground">{fmtUsd(s.total_cost)}</span>
                      }
                      sub={
                        <>
                          {name && (
                            <span className="font-mono text-muted-foreground/40">
                              {s.session_id.slice(0, 8)}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Sparkles className="size-3 text-kortix-blue" />
                            {fmtUsd(s.llm_cost)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Cpu className="size-3 text-muted-foreground" />
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
          </SectionCard>
        </div>

        {errorTypes.length > 0 && (
          <SectionCard
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
          </SectionCard>
        )}
      </div>
    </div>
  );
}
