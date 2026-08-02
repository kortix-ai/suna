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
 * case so the loading skeleton and the settled card never reflow vertically.
 *
 * Measured against the running app's compiled stylesheet: **83.42px** for a
 * two-line description. The math below reproduces that to within a
 * sub-pixel-rounding fraction — it must use this repo's actual spacing
 * token, `--spacing: 0.23rem` (`globals.css:670`), not Tailwind's framework
 * default of `0.25rem`, and it must count the button's own 1px top + 1px
 * bottom border, which is easy to forget because it isn't a `padding` line:
 *
 *   border (button, 1px top + 1px bottom)                       =  2.00px
 * + py-3.5 (2 x 3.5 x 0.23rem x 16px/rem)                        = 25.76px
 * + max(
 *     leading tile (size-9 = 9 x 0.23rem x 16px/rem)             = 33.12px,
 *     title row (text-sm line-height, 20px)
 *       + space-y-1 gap (1 x 0.23rem x 16px/rem)                 =  3.68px
 *       + two clamped description lines (text-xs, 16px each)     = 32.00px
 *                                                           total = 55.68px,
 *   )
 * = 2.00 + 25.76 + 55.68 = 83.44px  (measured: 83.42px; the ~0.02px gap is
 *   the browser's own sub-pixel layout rounding, not an error in this math)
 *
 * Rounded up to 84px so the skeleton is never a hair shorter than the real
 * card. Exported and reused by `capabilities-skeleton.tsx` (see its doc
 * comment) so the two heights cannot drift apart the way the grid breakpoint
 * once did.
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
