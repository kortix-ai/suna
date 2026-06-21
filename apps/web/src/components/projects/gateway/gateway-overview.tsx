'use client';

import { AlertTriangle, Coins, DollarSign, Zap } from 'lucide-react';

import { useGatewayOverview, useGatewaySeries } from '@/hooks/projects/use-project-gateway';

import { RangeSelector, StatCard, fmtCompact, fmtUsd, useGatewayRange } from './_metrics';

export function GatewayOverview({ projectId }: { projectId: string }) {
  const { days } = useGatewayRange();
  const { data: overview } = useGatewayOverview(projectId, days);
  const { data: seriesData } = useGatewaySeries(projectId, days);

  const requests = overview?.requests ?? 0;
  const errors = overview?.errors ?? 0;
  const cost = overview?.total_cost ?? 0;
  const inTokens = overview?.input_tokens ?? 0;
  const outTokens = overview?.output_tokens ?? 0;

  const series = seriesData?.series ?? [];
  const sparkSeries = series.map((s) => ({ ...s, tokens: s.input_tokens + s.output_tokens }));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-5">
        <RangeSelector />

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
      </div>
    </div>
  );
}
