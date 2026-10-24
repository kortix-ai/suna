'use client';

import { PROJECT_WIDE_SPACE, type SpaceGroup, type ProjectSpace } from '@kortix/sdk';

import { ALL_SPACES } from '../../customize/shared/catalog/catalog-space-tabs';
import { useTranslations } from '../../i18n';
import { CountBadge } from '../../primitives/count-badge';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '../../primitives/tabs';

/**
 * The space filter of a list page (Goals, Artifacts): `All`, one tab per
 * space of the project (an empty one included, with 0), then `Project-wide`.
 * Built from the spaces, not from the items, so the selected space always has
 * a tab. Renders nothing for a project without spaces.
 */
export function SpaceFilterTabs<T>({
  spaces,
  groups,
  value,
  onValueChange,
}: {
  /** `listSpaces(config)`. */
  spaces: ProjectSpace[];
  /** `groupBySpace(items, …)`: the counts. */
  groups: Array<SpaceGroup<T>>;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const t = useTranslations('spaces');
  if (spaces.length === 0 && value === ALL_SPACES) return null;
  const counts = new Map(groups.map((group) => [group.name, group.items.length]));
  const tabs = [
    ...spaces.map((space) => ({ name: space.name, label: space.label || space.name })),
    { name: PROJECT_WIDE_SPACE, label: t('projectWide') },
  ];

  return (
    <Tabs value={value} onValueChange={onValueChange} className="max-w-full overflow-x-auto">
      <TabsListCompact aria-label={t('filter')}>
        <TabsTriggerCompact value={ALL_SPACES}>{t('all')}</TabsTriggerCompact>
        {tabs.map((tab) => (
          <TabsTriggerCompact key={tab.name} value={tab.name}>
            {tab.label}
            <CountBadge count={counts.get(tab.name) ?? 0} tone="neutral" />
          </TabsTriggerCompact>
        ))}
      </TabsListCompact>
    </Tabs>
  );
}

/** The name a filtered empty state shows for `value`. */
export function spaceFilterLabel(value: string, spaces: ProjectSpace[], projectWide: string): string {
  if (value === PROJECT_WIDE_SPACE) return projectWide;
  const space = spaces.find((candidate) => candidate.name === value);
  return space?.label || space?.name || value;
}
