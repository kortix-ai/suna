'use client';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';

import { CATALOG_CARD_HEIGHT_CLASSNAME, GRID_CLASSNAME } from './catalog-grid-tokens';

export interface CatalogGridProps {
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  isEmpty: boolean;
  /** Rendered in place of the grid when `isEmpty` is true. The grid does not
   *  own empty copy — connectors, skills, and commands each know what their
   *  own "nothing here" invitation should say. */
  empty: ReactNode;
  children: ReactNode;
}

// Layout tokens live in `./catalog-grid-tokens` so this module exports only
// components and stays on React Fast Refresh's hot path.

const SKELETON_CARD_COUNT = 6;

/**
 * One catalog-card placeholder. Mirrors `CatalogCard`'s chrome (bordered
 * popover surface, leading tile, title + one description line) so the
 * loading → content handoff does not jump from a solid grey slab into a card.
 *
 * Deliberately sparse — one description bar, not two — so the skeleton reads
 * calmer than a packed mock of the settled card. Height still uses
 * `CATALOG_CARD_HEIGHT_CLASSNAME` so rows do not reflow when data arrives.
 */
export function CatalogCardSkeleton() {
  return <Skeleton className="h-20 w-full" />;
}

/**
 * The catalog loading grid shared by `CatalogGrid`, `CapabilitiesSkeleton`,
 * and every capabilities route. One component — connectors, skills, and
 * commands never diverge on loading chrome.
 */
export function CatalogGridSkeleton({
  count = SKELETON_CARD_COUNT,
}: {
  count?: number;
} = {}) {
  return (
    <div className={GRID_CLASSNAME} data-slot="catalog-grid-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <CatalogCardSkeleton key={index} />
      ))}
    </div>
  );
}

/**
 * The one grid shared by the connectors, skills, and commands catalog pages.
 * Owns the four states in design-system order: loading -> error -> empty ->
 * content. Callers only supply query state and the content/empty nodes.
 *
 * `sm:grid-cols-2 xl:grid-cols-3` (not `lg:grid-cols-3`) is deliberate: at
 * the `lg` breakpoint (1024-1279px) a 3-up card does not have room for a
 * title, a description line, and a trailing slot without truncating hard.
 * Loading chrome is `CatalogGridSkeleton` — the same surface
 * `capability-skeleton.tsx` paints behind the Suspense boundary — so the
 * loading-to-content handover never reflows a column or a row.
 */
export function CatalogGrid({
  isLoading,
  isError,
  onRetry,
  isEmpty,
  empty,
  children,
}: CatalogGridProps) {
  if (isLoading) {
    return <CatalogGridSkeleton />;
  }

  if (isError) {
    return (
      <ErrorState
        size="sm"
        title="Couldn't load"
        description="Check your connection and try again."
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    );
  }

  if (isEmpty) {
    return <>{empty}</>;
  }

  return <div className={GRID_CLASSNAME}>{children}</div>;
}
