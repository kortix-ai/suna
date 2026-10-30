'use client';

/**
 * The one left-rail recipe: Project admin and the agent page. A rail is
 * vertical `Tabs` whose rows are real links (the section is URL state),
 * grouped under muted labels in the account hub's dialect
 * (`account-settings-sidebar.tsx`).
 */

import type { ReactNode } from 'react';

import { cn } from '../lib/utils';
import { TabsList } from '../../primitives/tabs';

/**
 * Each group is its own labelled tablist: arrow keys move inside a group, Tab
 * moves to the next one. `after` sits below the list, outside it: a link that
 * is not a tab. A group without `label` draws no heading.
 */
export function RailGroup({ label, children, after }: { label?: string; children: ReactNode; after?: ReactNode }) {
  return (
    <div>
      {label ? <p className="text-muted-foreground flex h-8 items-center px-2.5 text-xs font-medium">{label}</p> : null}
      <TabsList orientation="vertical" aria-label={label} className="w-full">
        {children}
      </TabsList>
      {after}
    </div>
  );
}

/** A rail row: pass to `TabsTrigger` with `size="md"`. */
export const RAIL_ROW_CLASS = cn(
  'gap-2 px-2.5 py-1 font-normal transition-none has-[>svg]:px-2.5',
  'text-foreground data-[state=inactive]:text-foreground hover:bg-hover hover:text-foreground',
  'data-[state=active]:bg-active data-[state=active]:font-medium',
  '[&_svg]:text-muted-foreground data-[state=active]:[&_svg]:text-foreground',
);

/** The same row on the narrow-screen horizontal strip. */
export const RAIL_HORIZONTAL_ROW_CLASS = 'w-auto shrink-0 gap-2.5 px-3 py-0.75 whitespace-nowrap';
