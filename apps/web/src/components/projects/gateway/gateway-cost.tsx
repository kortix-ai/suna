'use client';

import { Microchip as Cpu, Sparkles } from '@mynaui/icons-react';

import { SectionCard } from '@/components/ui/section-card';
import {
  useGatewayBreakdown,
  useGatewaySeries,
  useGatewaySessions,
} from '@/hooks/projects/use-project-gateway';

import { displayModel, modelAccent } from './_shared';
import { MeterRow, RangeSelector, UsageChart, fmtUsd, useGatewayRange } from './_metrics';

export function GatewayCost({ projectId }: { projectId: string }) {
  const { days } = useGatewayRange();
  const { data: seriesData } = useGatewaySeries(projectId, days);
  const { data: breakdown } = useGatewayBreakdown(projectId, days);
  const { data: sessionsData } = useGatewaySessions(projectId, days);

  const series = seriesData?.series ?? [];
  const models = [...(breakdown?.models ?? [])].sort((a, b) => b.cost - a.cost);
  const maxModelCost = Math.max(0.000001, ...models.map((m) => m.cost));
  const sessions = sessionsData?.sessions ?? [];
  const maxSessionCost = Math.max(0.000001, ...sessions.map((s) => s.total_cost));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-5">
        <RangeSelector />

        <SectionCard title="Spend" description="Daily cost routed through the gateway">
          <UsageChart data={series} keys={['cost']} yFormatter={fmtUsd} />
        </SectionCard>

        <SectionCard title="Top models" count={models.length} description="Cost by model across this window">
          {models.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No requests yet.</div>
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
          description="Total cost per session — LLM + sandbox compute"
        >
          {sessions.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No sessions yet.</div>
          ) : (
            <div className="space-y-0.5">
              {sessions.map((s, i) => (
                <MeterRow
                  key={s.session_id}
                  rank={i + 1}
                  accent={modelAccent(s.session_id)}
                  label={s.session_id.slice(0, 8)}
                  value={<span className="font-semibold text-foreground">{fmtUsd(s.total_cost)}</span>}
                  sub={
                    <>
                      <span className="inline-flex items-center gap-1">
                        <Sparkles className="size-3 text-chart-1" />
                        {fmtUsd(s.llm_cost)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Cpu className="size-3 text-chart-4" />
                        {fmtUsd(s.compute_cost)}
                      </span>
                      <span className="text-muted-foreground/50">{s.requests.toLocaleString()} req</span>
                    </>
                  }
                  segments={[
                    { pct: (s.llm_cost / maxSessionCost) * 100, color: 'var(--chart-1)' },
                    { pct: (s.compute_cost / maxSessionCost) * 100, color: 'var(--chart-4)' },
                  ]}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
