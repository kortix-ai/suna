import type { DomainGroup } from '@kortix/sdk';

import { CountBadge } from '../../../primitives/count-badge';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '../../../primitives/tabs';

/** The sentinel filter value that shows every domain (grouped). */
export const ALL_DOMAINS = 'all';

/**
 * A compact segmented filter over a project's domains: `All` plus one chip per
 * domain, each with its count. Selecting a domain scopes the catalog to it;
 * `All` shows the grouped sections. Pairs with `groupByDomain` + the catalog
 * views. Renders nothing when there is only the default bucket (no real split).
 */
export function DomainFilterTabs<T>({
  groups,
  value,
  onValueChange,
}: {
  groups: Array<DomainGroup<T>>;
  value: string;
  onValueChange: (value: string) => void;
}) {
  // Only worth a filter when the project actually splits into domains.
  const hasRealSplit = groups.some((g) => !g.isDefault);
  if (!hasRealSplit) return null;

  return (
    <Tabs value={value} onValueChange={onValueChange}>
      <TabsListCompact aria-label="Filter by domain">
        <TabsTriggerCompact value={ALL_DOMAINS}>All</TabsTriggerCompact>
        {groups.map((group) => (
          <TabsTriggerCompact key={group.name} value={group.name}>
            {group.label}
            <CountBadge count={group.items.length} tone="neutral" />
          </TabsTriggerCompact>
        ))}
      </TabsListCompact>
    </Tabs>
  );
}
