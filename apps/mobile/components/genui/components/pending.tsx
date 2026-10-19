import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { GenuiNode } from '@kortix/sdk/genui';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { mapStyleUrl } from '@/lib/genui/map-style';

/*
 * Final heights of the components that would otherwise jump when they finish streaming, in pt
 * (stock Tailwind spacing, 4pt a step; inlineRem 16, so a text-sm line is 20pt).
 *
 * The chart card (`chart-card.tsx`) is p-4 with gap-2 (8) between rows. Its header row is the 20pt title
 * beside Show data, a 20pt line in py-0.5: 24.
 */
/** The bar and line plot. */
export const CHART_PLOT = 160;
/** Every pie layout (treemap, stack, gauge, focus, donut, ring) fills this block. */
export const PIE_BLOCK = 200;
/**
 * Bar / line: p-4 16 + header 24 + 8 + one-row legend (a 20pt line in py-0.5) 24 + 8 + plot 160 + 8
 * + x labels 20 + p-4 16 = 284. A wrapped legend, a tapped value row, or a larger text size grows it.
 */
export const CHART_CARD_HEIGHT = 284;
/** Pie: p-4 16 + header 24 + 8 + PIE_BLOCK 200 + p-4 16 = 264. A pie has no series legend row. */
export const PIE_CARD_HEIGHT = 264;
/** The inline map's reserved height. */
export const MAP_HEIGHT = 320;
/**
 * Table (`data.tsx`): a header row and three body rows, each a 20pt line in py-2: 4 × 36 = 144.
 * A table's height is its row count, which is not known while it streams; a longer table grows.
 */
const TABLE_HEIGHT = 144;

const RESERVED: Record<string, number> = {
  Table: TABLE_HEIGHT,
  BarChart: CHART_CARD_HEIGHT,
  LineChart: CHART_CARD_HEIGHT,
  PieChart: PIE_CARD_HEIGHT,
  Map: MAP_HEIGHT,
};

/** A node the model has not finished: heavy nodes hold their space with the Kortix loader; text nodes wait invisibly. */
export function GenuiPending(node: GenuiNode): ReactNode {
  // With the map off the settled Map is a list of places, text that grows like prose: nothing to reserve (web parity).
  if (node.type === 'Map' && !mapStyleUrl(false)) return null;
  const height = RESERVED[node.type];
  if (!height) return null;
  return (
    <View style={{ height }} className="items-center justify-center rounded-2xl bg-card" accessibilityState={{ busy: true }}>
      <KortixLoader />
    </View>
  );
}
