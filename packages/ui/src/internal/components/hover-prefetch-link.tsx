'use client';

import { useUiLink, type UiLinkProps } from '../../providers/ui-provider';
import { forwardRef, useState } from 'react';

export interface HoverPrefetchLinkProps extends Omit<UiLinkProps, 'prefetch' | 'ref'> {
  /**
   * Which prefetch kind to switch on once the pointer/focus reaches the link.
   * Mirrors `next/link`'s own prop: `null` (default) = the automatic
   * layout-to-`loading.tsx` prefetch, `true` = the full page payload.
   */
  prefetch?: boolean | null;
}

/**
 * The host link (`useUiLink`: `next/link` in apps/web) that prefetches on
 * *intent* (hover, focus, touch) instead of on mount. Next's own answer to "Preventing too many prefetches"
 * (node_modules/next/dist/docs/01-app/02-guides/prefetching.md:302).
 *
 * Why it exists — measured, not theorised. A single session open on the
 * production build issued **21 RSC fetches of the session page route**: one for
 * the page actually being opened and 19-20 more for every *other* session row
 * the sidebar rendered, because `<Link>` prefetches everything in the viewport.
 * Each of those is a dynamic server render of a full session page (~24KB of
 * flight payload, median 480ms server time on the SampleCo deployment, 423 hits
 * across a 20-open corpus) for a route the user will almost never open.
 *
 * Intent-gating keeps the click fast — a pointer reaches a sidebar row 100-300ms
 * before the click lands, which is the whole prefetch window anyway — while a
 * session open that touches nothing costs zero prefetches. Keyboard (`focus`)
 * and touch (`touchstart`) arm it too, so the win is not mouse-only.
 *
 * Once armed the link stays armed: `prefetch` is a plain `<Link>` prop from then
 * on, so Next's own prefetch cache and staleness rules apply unchanged.
 */
export const HoverPrefetchLink = forwardRef<HTMLAnchorElement, HoverPrefetchLinkProps>(
  function HoverPrefetchLink(
    { prefetch = null, onMouseEnter, onFocus, onTouchStart, ...props },
    ref,
  ) {
    const Link = useUiLink();
    const [armed, setArmed] = useState(false);

    return (
      <Link
        {...props}
        ref={ref}
        prefetch={armed ? prefetch : false}
        onMouseEnter={(event) => {
          setArmed(true);
          onMouseEnter?.(event);
        }}
        onFocus={(event) => {
          setArmed(true);
          onFocus?.(event);
        }}
        onTouchStart={(event) => {
          setArmed(true);
          onTouchStart?.(event);
        }}
      />
    );
  },
);
