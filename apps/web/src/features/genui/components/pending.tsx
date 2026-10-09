import type { ReactNode } from 'react';

import Loading from '@/components/ui/loading';

import type { GenuiNode } from '../sdk';

/**
 * The closed chart figure in `charts.tsx`, top to bottom (`--spacing` 0.23rem = 3.68px, text-xs line 16px):
 * plot block 244 + gap-2 7.36 + figcaption 16 + gap-2 7.36 + summary (16 + py-1 7.36) 23.36 = 298.08px.
 * The figure sets this same min-height, so the pending block and the settled figure are one height.
 */
export const CHART_FIGURE_HEIGHT = 'min-h-[299px]';

/** Final boxes of the components that would otherwise jump when they finish streaming. A border only where the settled component has one. */
const RESERVED: Record<string, string> = {
  Table: 'min-h-[160px] border-border rounded-md border',
  BarChart: CHART_FIGURE_HEIGHT,
  LineChart: CHART_FIGURE_HEIGHT,
  PieChart: CHART_FIGURE_HEIGHT,
  Map: 'min-h-[280px] border-border rounded-md border',
};

/** A node the model has not finished. Heavy nodes hold their space with the one Kortix spinner; text nodes wait invisibly. */
export function GenuiPending(node: GenuiNode): ReactNode {
  const reserved = RESERVED[node.type];
  if (!reserved) return null;
  return (
    <div className={`${reserved} flex w-full items-center justify-center`} aria-busy="true">
      <Loading />
    </div>
  );
}
