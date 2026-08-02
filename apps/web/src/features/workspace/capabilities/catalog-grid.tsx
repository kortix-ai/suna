'use client';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';

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

/**
 * Shared by the loading skeleton and the real grid so the two class strings
 * cannot drift apart — see the breakpoint note below. Exported so
 * `capabilities-skeleton.tsx` imports this exact value instead of restating
 * it; two independently hand-typed copies of the same breakpoint is what
 * caused this class of grid to drift out of sync in the first place.
 */
export const GRID_CLASSNAME = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3';

/**
 * Height of a real `CatalogCard`, sized to the common two-line-description
 * case so the loading skeleton and the settled card never reflow vertically:
 *
 *   py-3.5                                                    = 28px (14 + 14)
 * + max(
 *     leading tile (size-9)                                   = 36px,
 *     title row (text-sm, 20px line-height)
 *       + space-y-1 gap                                       =  4px
 *       + two clamped description lines (text-xs, 16px each)  = 32px
 *                                                         total = 56px,
 *   )
 * = 28 + 56 = 84px
 *
 * Exported and reused by `capabilities-skeleton.tsx` (see its doc comment)
 * so the two heights cannot drift apart the way the grid breakpoint once did.
 */
export const CATALOG_CARD_HEIGHT_CLASSNAME = 'h-[84px]';

const SKELETON_CARD_COUNT = 6;
const skeletonCards = Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => index);

/**
 * The one grid shared by the connectors, skills, and commands catalog pages.
 * Owns the four states in design-system order: loading -> error -> empty ->
 * content. Callers only supply query state and the content/empty nodes.
 *
 * `sm:grid-cols-2 xl:grid-cols-3` (not `lg:grid-cols-3`) is deliberate: at
 * the `lg` breakpoint (1024-1279px) a 3-up card does not have room for a
 * title, a description line, and a trailing slot without truncating hard.
 * `capabilities-skeleton.tsx` mirrors this exact breakpoint, and imports
 * `CATALOG_CARD_HEIGHT_CLASSNAME` for its own skeleton cards, so the
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
    return (
      <div className={GRID_CLASSNAME}>
        {skeletonCards.map((index) => (
          <Skeleton key={index} className={cn(CATALOG_CARD_HEIGHT_CLASSNAME, 'rounded-md')} />
        ))}
      </div>
    );
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
