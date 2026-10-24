import type { SpaceGroup } from '@kortix/sdk';
import type { ReactNode } from 'react';

import { GRID_CLASSNAME } from './catalog-grid-tokens';

/**
 * Renders catalog entities grouped into space sections — the same section
 * shape the Agents page already uses for its subagents block (a labelled
 * `<section>` with a count, an optional one-line description, and the shared
 * card grid). Groups come from `groupBySpace` in `@kortix/sdk`; the
 * Project-wide bucket (entities with no space) renders last.
 *
 * A project that declares no spaces produces one Project-wide group holding
 * every entity, which reads as a single flat grid.
 */
export function CatalogSpaceSections<T extends { space?: string | null }>({
  groups,
  renderCard,
}: {
  groups: Array<SpaceGroup<T>>;
  renderCard: (item: T) => ReactNode;
}) {
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <section key={group.name} aria-labelledby={`space-${group.name}`} className="space-y-2">
          <div>
            <h2 id={`space-${group.name}`} className="text-foreground text-sm font-medium">
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
