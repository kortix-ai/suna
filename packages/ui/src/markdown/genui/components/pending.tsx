import type { ReactNode } from 'react';

import Loading from '../../../primitives/loading';

import type { GenuiNode } from '../sdk';
import { mapStyles } from './map-geo';

/**
 * The closed chart figure in `charts.tsx`, top to bottom (`--spacing` 0.23rem = 3.68px, text-xs line 16px):
 * header row (the Show data button, 16 + py-1 7.36, beside the 20px title) 23.36 + gap-2 7.36 + plot block 244
 * = 274.72px.
 * The figure sets this same min-height, so the pending block and the settled figure are one height.
 */
export const CHART_FIGURE_HEIGHT = 'min-h-[275px]';

/** The map's bordered canvas box in `map.tsx`. The border sits on this box, not on the figure. */
export const MAP_BOX = 'border-border h-[380px] w-full overflow-hidden rounded-md border';

/**
 * The map figure in `map.tsx` when a tile style is configured: the card's 1px top and bottom border around the
 * map well (MAP_BOX, 380px) = 382px. No caption: the source is in the figure's label only.
 * The pending block sets this same min-height, so it and the settled figure are one height.
 */
export const MAP_FIGURE_HEIGHT = 'min-h-[382px]';

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
    // With the map switched off it is a list of places, text that grows like prose: nothing to reserve.
    if (!mapStyles()) return null;
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
