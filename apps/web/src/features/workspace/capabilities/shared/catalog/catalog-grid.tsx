'use client';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';

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
 * surface, leading tile, title + one description line) so the loading →
 * content handoff does not jump from a solid grey slab into a card.
 *
 * Deliberately sparse — one description bar, not two — so the skeleton reads
 * calmer than a packed mock of the settled card.
 *
 * The height comes from `CATALOG_CARD_HEIGHT_CLASSNAME`, not from the inner
 * shapes, so the outer box is exactly the real card's 84px no matter how the
 * inside is composed. It was hardcoded `h-20` (80px) while that token sat
 * imported-but-unused, which cost 4px of reflow per row on every catalog load.
 */
export function CatalogCardSkeleton() {
  return (
    <div
      className={cn(
        'border-border/60 flex w-full items-start gap-3 rounded-md border px-4 py-3.5',
        CATALOG_CARD_HEIGHT_CLASSNAME,
      )}
      data-slot="catalog-card-skeleton"
    >
      <Skeleton className="size-10 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <Skeleton className="h-3.5 w-2/5 rounded-sm" />
        <Skeleton className="h-3 w-full rounded-sm" />
      </div>
    </div>
  );
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
