import { MagnifyingGlassIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../../i18n';
import { EmptyState } from '../../../primitives/empty-state';
import type { ReactNode } from 'react';

/**
 * The "nothing here" state every catalog uses: the shared `EmptyState`, so a
 * catalog's empty slot looks like every other empty view. `CatalogGrid` owns
 * loading/error/empty; this is what callers put IN the empty slot when the
 * cause is the search box rather than an empty project.
 */
export function CatalogEmptyNote({ children }: { children: ReactNode }) {
  return <EmptyState size="sm" icon={MagnifyingGlassIcon} title={children} />;
}

/**
 * "No matches for `<query>`."
 *
 * The query is trimmed HERE, once. Echoing it raw put the user's own trailing
 * spaces inside a monospace span, which reads as a rendering bug rather than as
 * a report of what was searched for.
 */
export function CatalogNoMatch({ query }: { query: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <CatalogEmptyNote>
      {tI18nComplete.raw('texta8897de42124')}{' '}
      <span className="text-foreground font-mono">{query.trim()}</span>.
    </CatalogEmptyNote>
  );
}
