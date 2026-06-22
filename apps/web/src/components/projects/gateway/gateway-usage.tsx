'use client';

import { SectionCard } from '@/components/ui/section-card';
import { useGatewayErrors, useGatewaySeries } from '@/hooks/projects/use-project-gateway';

import { MeterRow, RangeSelector, UsageChart, fmtCompact, useGatewayRange } from './_metrics';

export function GatewayUsage({ projectId }: { projectId: string }) {
  const { days } = useGatewayRange();
  const { data: seriesData } = useGatewaySeries(projectId, days);
  const { data: errorData } = useGatewayErrors(projectId, days);

  const series = seriesData?.series ?? [];
  const errorTypes = errorData?.errors ?? [];
  const maxErrorCount = Math.max(1, ...errorTypes.map((e) => e.count));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-5">
        <RangeSelector />

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Requests" description="Successful requests and errors per day">
            <UsageChart data={series} keys={['requests', 'errors']} yFormatter={(v) => v.toLocaleString()} />
          </SectionCard>
          <SectionCard title="Tokens" description="Input and output tokens per day">
            <UsageChart data={series} keys={['input_tokens', 'output_tokens']} yFormatter={fmtCompact} />
          </SectionCard>
        </div>

        <SectionCard title="Latency" description="Response time percentiles per day (ms)">
          <UsageChart data={series} keys={['p50', 'p95', 'p99']} yFormatter={(v) => `${fmtCompact(v)}ms`} />
        </SectionCard>

        {errorTypes.length > 0 && (
          <SectionCard title="Errors by type" count={errorTypes.length} description="What's failing across this window">
            <div className="space-y-0.5">
              {errorTypes.map((e, i) => (
                <MeterRow
                  key={e.code}
                  rank={i + 1}
                  accent="var(--chart-4)"
                  label={e.code}
                  value={e.count.toLocaleString()}
                  segments={[{ pct: (e.count / maxErrorCount) * 100, color: 'var(--chart-4)' }]}
                />
              ))}
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}
