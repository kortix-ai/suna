'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Coins, Cpu, DollarSign, Sparkles, Zap } from 'lucide-react';

import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { listProjectSessions } from '@kortix/sdk/projects-client';
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
  // raw uuid. Map both the Kortix project session id and runtime session id
  // since the gateway may key on either.
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
      if (s.runtime_session_id) m.set(s.runtime_session_id, label);
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
          </Panel>

          <Panel
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

/**
 * Hand-composed analytics panel — the design-system `bg-popover rounded-md
 * border` surface (replaces the deprecated SectionCard). Header carries the
 * title / count / description / action; padding lives on the inner sections,
 * never the bordered shell.
 */
function Panel({
  title,
  count,
  description,
  action,
  children,
}: {
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-popover overflow-hidden rounded-md border">
      <div className="border-border/60 flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-foreground text-sm font-medium">
            {title}
            {count != null && <span className="text-muted-foreground font-normal"> ({count})</span>}
          </h3>
          {description != null && (
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
          )}
        </div>
        {action != null && <div className="shrink-0">{action}</div>}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}
