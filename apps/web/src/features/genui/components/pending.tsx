import type { ReactNode } from 'react';

import Loading from '@/components/ui/loading';

import type { GenuiNode } from '../sdk';

/**
 * The closed chart figure in `charts.tsx`, top to bottom (`--spacing` 0.23rem = 3.68px, text-xs line 16px):
 * plot block 244 + gap-2 7.36 + figcaption 16 + gap-2 7.36 + summary (16 + py-1 7.36) 23.36 = 298.08px.
 * The figure sets this same min-height, so the pending block and the settled figure are one height.
 */
export const CHART_FIGURE_HEIGHT = 'min-h-[299px]';

/** The map's bordered canvas box in `map.tsx`. The border sits on this box, not on the figure. */
export const MAP_BOX = 'border-border h-[280px] w-full overflow-hidden rounded-md border';

/**
 * The map figure in `map.tsx` when a tile style is configured, top to bottom:
 * map box 280 + gap-2 7.36 + figcaption (text-xs line) 16 = 303.36px.
 * The figure sets this same min-height, so the pending block and the settled figure are one height.
 */
export const MAP_FIGURE_HEIGHT = 'min-h-[304px]';

/** Final boxes of the components that would otherwise jump when they finish streaming. A border only where the settled component has one. */
const RESERVED: Record<string, string> = {
  Table: 'min-h-[160px] border-border rounded-md border',
  BarChart: CHART_FIGURE_HEIGHT,
  LineChart: CHART_FIGURE_HEIGHT,
  PieChart: CHART_FIGURE_HEIGHT,
};

/** A node the model has not finished. Heavy nodes hold their space with the one Kortix spinner; text nodes wait invisibly. */
export function GenuiPending(node: GenuiNode): ReactNode {
  if (node.type === 'Map') {
    // Without a tile style the map is a place list, text that grows like prose: nothing to reserve.
    if (!process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL) return null;
    return (
      <div className={`${MAP_FIGURE_HEIGHT} flex w-full flex-col`} aria-busy="true">
        <div className={`${MAP_BOX} flex items-center justify-center`}>
          <Loading />
        </div>
      </div>
    );
  }
  const reserved = RESERVED[node.type];
  if (!reserved) return null;
  return (
    <div className={`${reserved} flex w-full items-center justify-center`} aria-busy="true">
      <Loading />
    </div>
  );
}
