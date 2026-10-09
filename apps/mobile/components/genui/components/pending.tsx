import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { GenuiNode } from '@kortix/sdk/genui';

import { KortixLoader } from '@/components/kortix/kortix-loader';

/** Final heights of the components that would otherwise jump when they finish streaming. */
// Charts: the single-series card `charts.tsx` draws (p-4, max label, 160pt plot, x labels, footer); a pie has no axis rows.
const RESERVED: Record<string, number> = { Table: 160, BarChart: 284, LineChart: 284, PieChart: 256 };

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
