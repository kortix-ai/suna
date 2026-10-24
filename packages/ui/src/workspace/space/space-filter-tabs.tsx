'use client';

import { DEFAULT_PROJECT_DOMAIN, type DomainGroup, type ProjectDomain } from '@kortix/sdk';

import { ALL_DOMAINS } from '../../customize/shared/catalog/domain-filter-tabs';
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
  spaces: ProjectDomain[];
  /** `groupBySpace(items, …)`: the counts. */
  groups: Array<DomainGroup<T>>;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const t = useTranslations('spaces');
  if (spaces.length === 0 && value === ALL_DOMAINS) return null;
  const counts = new Map(groups.map((group) => [group.name, group.items.length]));
  const tabs = [
    ...spaces.map((space) => ({ name: space.name, label: space.label || space.name })),
    { name: DEFAULT_PROJECT_DOMAIN, label: t('projectWide') },
  ];

  return (
    <Tabs value={value} onValueChange={onValueChange} className="max-w-full overflow-x-auto">
      <TabsListCompact aria-label={t('filter')}>
        <TabsTriggerCompact value={ALL_DOMAINS}>{t('all')}</TabsTriggerCompact>
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
export function spaceFilterLabel(value: string, spaces: ProjectDomain[], projectWide: string): string {
  if (value === DEFAULT_PROJECT_DOMAIN) return projectWide;
  const space = spaces.find((candidate) => candidate.name === value);
  return space?.label || space?.name || value;
}
