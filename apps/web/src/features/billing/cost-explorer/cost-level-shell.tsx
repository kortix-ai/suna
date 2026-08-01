'use client';

import type { CostSummary } from '@kortix/sdk';

import { DateRangePicker, type CostRange } from '@/components/ui/date-range-picker';
import { InfoBanner } from '@/components/ui/info-banner';

import { CostChart } from './cost-chart';
import { CostModelList } from './cost-model-list';
import { CostSummaryTiles, type CostSummaryTile } from './cost-summary-tiles';

export interface CostLevelShellProps {
  range: CostRange;
  onRangeChange: (next: CostRange) => void;
  summary: CostSummary | undefined;
  isSummaryLoading: boolean;
  summaryError: Error | null;
  extraTiles?: CostSummaryTile[];
  /** Defaults to shown — pass `false` to hide (e.g. a single-session scope,
   *  where a day-bucketed spend chart has nothing meaningful to show). */
  showChart?: boolean;
  controls?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The one shell shared by all three cost explorer levels — project, sessions,
 * session. Each level answers the same question ("what did this cost over
 * this window, and what is inside it") at a different scope, so the shell
 * never branches on which level it is in: it always renders the same stack
 * of range control, error banner, summary tiles, chart and model breakdown,
 * and leaves the level-specific table to `children`.
 */
export function CostLevelShell({
  range,
  onRangeChange,
  summary,
  isSummaryLoading,
  summaryError,
  extraTiles = [],
  showChart,
  controls,
  children,
}: CostLevelShellProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker value={range} onChange={onRangeChange} />
        {controls != null ? <div className="flex items-center gap-2">{controls}</div> : null}
      </div>

      {summaryError ? (
        <InfoBanner tone="destructive" title="Failed to load cost summary">
          {summaryError.message}
        </InfoBanner>
      ) : null}

      <CostSummaryTiles summary={summary} isLoading={isSummaryLoading} extraTiles={extraTiles} />

      {showChart !== false ? (
        <CostChart series={summary?.series ?? []} isLoading={isSummaryLoading} />
      ) : null}

      <CostModelList models={summary?.models ?? []} />

      {children}
    </div>
  );
}
