import type { ReactNode } from 'react';

import Loading from '@/components/ui/loading';

import type { GenuiNode } from '../sdk';

/** Final heights of the components that would otherwise jump when they finish streaming. */
const RESERVED: Record<string, string> = {
  Table: 'min-h-[160px]',
  BarChart: 'min-h-[220px]',
  LineChart: 'min-h-[220px]',
  PieChart: 'min-h-[220px]',
  Map: 'min-h-[280px]',
};

/** A node the model has not finished. Heavy nodes hold their space with the one Kortix spinner; text nodes wait invisibly. */
export function GenuiPending(node: GenuiNode): ReactNode {
  const reserved = RESERVED[node.type];
  if (!reserved) return null;
  return (
    <div className={`${reserved} border-border flex w-full items-center justify-center rounded-md border`} aria-busy="true">
      <Loading />
    </div>
  );
}
