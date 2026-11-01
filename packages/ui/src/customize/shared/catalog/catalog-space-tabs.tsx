import { useTranslations } from '../../../i18n';

import type { SpaceGroup } from '@kortix/sdk';

import { CountBadge } from '../../../primitives/count-badge';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '../../../primitives/tabs';

/** The sentinel filter value that shows every space (grouped). */
export const ALL_SPACES = 'all';

/**
 * A compact segmented filter over a project's spaces: `All` plus one chip per
 * space, each with its count. Selecting a space scopes the catalog to it;
 * `All` shows the grouped sections. Pairs with `groupBySpace` + the catalog
 * views. Renders nothing when there is only the Project-wide bucket.
 */
export function CatalogSpaceTabs<T>({
  groups,
  value,
  onValueChange,
}: {
  groups: Array<SpaceGroup<T>>;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const t = useTranslations('spaces');
  // Only worth a filter when the project actually splits into spaces.
  const hasRealSplit = groups.some((g) => !g.isDefault);
  if (!hasRealSplit) return null;

  return (
    <Tabs value={value} onValueChange={onValueChange}>
      <TabsListCompact aria-label={t('filter')}>
        <TabsTriggerCompact value={ALL_SPACES}>{t('all')}</TabsTriggerCompact>
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
