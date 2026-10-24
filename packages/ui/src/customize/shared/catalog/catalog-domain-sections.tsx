import type { DomainGroup } from '@kortix/sdk';
import type { ReactNode } from 'react';

import { GRID_CLASSNAME } from './catalog-grid-tokens';

/**
 * Renders catalog entities grouped into domain sections — the same section
 * shape the Agents page already uses for its subagents block (a labelled
 * `<section>` with a count, an optional one-line description, and the shared
 * card grid). Groups come from `groupByDomain` in `@kortix/sdk`; the default
 * bucket (entities with no domain) renders last and is labelled there.
 *
 * Backward compatible: a project that declares no domains produces one default
 * group holding every entity, which reads as today's single flat grid.
 */
export function CatalogDomainSections<T extends { domain?: string | null }>({
  groups,
  renderCard,
}: {
  groups: Array<DomainGroup<T>>;
  renderCard: (item: T) => ReactNode;
}) {
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <section key={group.name} aria-labelledby={`domain-${group.name}`} className="space-y-2">
          <div>
            <h2 id={`domain-${group.name}`} className="text-foreground text-sm font-medium">
              {group.label}{' '}
              <span className="text-muted-foreground font-normal tabular-nums">{group.items.length}</span>
            </h2>
            {group.description ? (
              <p className="text-muted-foreground mt-1 text-xs">{group.description}</p>
            ) : null}
          </div>
          <div className={GRID_CLASSNAME}>{group.items.map(renderCard)}</div>
        </section>
      ))}
    </div>
  );
}
