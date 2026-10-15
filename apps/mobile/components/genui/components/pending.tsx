import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { GenuiNode } from '@kortix/sdk/genui';

import { KortixLoader } from '@/components/kortix/kortix-loader';

/** Final heights of the components that would otherwise jump when they finish streaming. */
// Charts: the card `charts.tsx` draws, top to bottom (gap-2 = 8pt, a text-sm line = 20pt):
// bar / line: p-4 16 + header row 20 + 8 + one-line legend 20 + 8 + max label 20 + 8 + plot 160 + 8 + x labels 20 + p-4 16 = 304.
// pie: p-4 16 + header row 20 + 8 + PIE_BLOCK 200 + p-4 16 = 260 (every pie layout fills PIE_BLOCK).
// A legend that wraps is taller.
const RESERVED: Record<string, number> = { Table: 160, BarChart: 304, LineChart: 304, PieChart: 260 };

/** A node the model has not finished: heavy nodes hold their space with the Kortix loader; text nodes wait invisibly. */
export function GenuiPending(node: GenuiNode): ReactNode {
  const height = RESERVED[node.type];
  if (!height) return null;
  return (
    <View style={{ height }} className="items-center justify-center rounded-2xl bg-card" accessibilityState={{ busy: true }}>
      <KortixLoader />
    </View>
  );
}
