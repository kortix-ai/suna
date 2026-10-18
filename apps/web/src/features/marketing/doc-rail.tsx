'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The document rail shared by the long-form public pages (`/legal`,
 * `/support`).
 *
 * One presentation per breakpoint, from one markup block: a horizontal
 * scroller below `lg` that bleeds to the viewport edge, and a sticky vertical
 * list from `lg` up. This is the shape every reference legal/support page
 * converges on (Stripe, Mistral, Craft, Clay) and it is structurally the same
 * split `/changelog` already ships — a sticky identity column beside the body.
 *
 * `/legal` drives document switching with it (buttons + `?tab=`), `/support`
 * drives in-page anchors (links + scroll-spy). Both get the same geometry,
 * hit area, and selected state because both call the helpers here.
 */

/**
 * `min-h-10` is the 40px minimum hit area — `py-2.5` on its own lands at 38px.
 * `whitespace-nowrap` keeps pills intact while horizontally scrolling, then
 * unsets at `lg` so long labels may wrap inside the 13rem column.
 */
const ITEM = cn(
  'flex min-h-10 w-full shrink-0 items-center gap-1.5 rounded-md px-3 py-2.5',
  'text-left text-sm whitespace-nowrap transition-colors lg:whitespace-normal',
  'focus-visible:ring-ring focus-visible:ring-offset-background',
  'focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
);

const INACTIVE = 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]';

/**
 * Selection is a foreground tint, never `bg-muted` — a muted fill is the
 * page's own surface colour and stops reading as "selected".
 */
const ACTIVE = 'bg-foreground/[0.06] text-foreground font-medium';

/** Class string for one rail entry. Works on a `<button>` or an `<a>`. */
export function docRailItem(active = false, className?: string) {
  return cn(ITEM, active ? ACTIVE : INACTIVE, className);
}

/** Grid that pairs the rail with the document body. */
export const DOC_GRID =
  'grid gap-x-12 gap-y-8 py-10 sm:py-14 lg:grid-cols-[13rem_minmax(0,1fr)] lg:py-16';

/**
 * The body column. `max-w-[68ch]` caps the measure — the free grid column runs
 * ~850px on xl, far past a readable line length for body copy.
 */
export const DOC_BODY = 'min-w-0 max-w-[68ch]';

export function DocRail({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        // The -mx-6/px-6 pair cancels the page gutter so the scroller reaches
        // the viewport edge instead of clipping the last pill mid-word.
        '-mx-6 flex gap-1 overflow-x-auto px-6 pb-1 lg:mx-0 lg:px-0 lg:pb-0',
        'scrollbar-hide lg:sticky lg:top-24 lg:h-fit lg:flex-col lg:gap-0.5',
        className,
      )}
    >
      {children}
    </nav>
  );
}
