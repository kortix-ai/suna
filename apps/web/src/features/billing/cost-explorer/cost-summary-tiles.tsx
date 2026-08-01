import type { CostSummary } from '@kortix/sdk';

import { Skeleton } from '@/components/ui/skeleton';

import { formatSessionCostUsd } from '../session-cost-format';

export interface CostSummaryTile {
  label: string;
  value: string;
}

export interface CostSummaryTilesProps {
  summary: CostSummary | undefined;
  isLoading: boolean;
  extraTiles: CostSummaryTile[];
}

export interface PeriodDelta {
  label: string;
  direction: 'up' | 'down' | 'flat';
}

export function formatPeriodDelta(current: number, previous: number): PeriodDelta | null {
  // A percentage against zero is meaningless, not infinite. Show nothing.
  if (previous <= 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return { label: '0%', direction: 'flat' };
  return { label: `${change > 0 ? '+' : ''}${change}%`, direction: change > 0 ? 'up' : 'down' };
}

// Grid dialect matches session-cost-detail.tsx:124 — the one divided-grid tile
// treatment this product surface uses. Loading renders the same shape so the
// layout never shifts once real figures arrive.
const GRID_CLASS =
  'border-border grid grid-cols-2 divide-x divide-y overflow-hidden rounded-md border sm:grid-cols-3';

export function CostSummaryTiles({ summary, isLoading, extraTiles }: CostSummaryTilesProps) {
  if (isLoading || !summary) {
    const tileCount = 3 + extraTiles.length;
    return (
      <div className={GRID_CLASS} aria-label="Loading cost summary">
        {Array.from({ length: tileCount }).map((_, index) => (
          <div key={index} className="px-3 py-2.5">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-2 ml-auto h-5 w-16" />
          </div>
        ))}
      </div>
    );
  }

  const delta = formatPeriodDelta(summary.totals.total_cost, summary.previous.total_cost);

  const tiles: (CostSummaryTile & { delta?: PeriodDelta | null })[] = [
    { label: 'Total', value: formatSessionCostUsd(summary.totals.total_cost), delta },
    { label: 'LLM', value: formatSessionCostUsd(summary.totals.llm_cost) },
    { label: 'Compute', value: formatSessionCostUsd(summary.totals.compute_cost) },
    ...extraTiles,
  ];

  return (
    <div className={GRID_CLASS}>
      {tiles.map((tile) => (
        <div key={tile.label} className="px-3 py-2.5">
          <p className="text-muted-foreground text-xs">{tile.label}</p>
          <p className="mt-0.5 text-right font-mono text-sm font-medium tabular-nums">
            {tile.value}
          </p>
          {/* The delta is muted text beneath the total, never a coloured badge —
              green-up/red-down on a cost figure is ambiguous (is spending less
              "good"?) and would add decorative colour to a one-accent surface. */}
          {tile.delta ? (
            <p className="text-muted-foreground mt-0.5 text-right text-xs tabular-nums">
              {tile.delta.label} vs prior period
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
