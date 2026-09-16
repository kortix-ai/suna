'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * How far before the foot of the scroll box the next page starts loading.
 * 400px is about twelve 32px session rows of lead time, so the next page is
 * usually in hand before the user reaches the end of the loaded list.
 */
const LOAD_MORE_ROOT_MARGIN = '0px 0px 400px 0px';

/** Whether the sentinel coming into view should load the next page. */
export function shouldLoadMore(
  isIntersecting: boolean,
  state: { hasMore: boolean; isLoadingMore: boolean },
): boolean {
  return isIntersecting && state.hasMore && !state.isLoadingMore;
}

/**
 * Infinite scroll for a list inside its own scroll box: attach the returned
 * ref to an empty element after the last row, and the next page loads as that
 * element nears the bottom of `rootRef`.
 *
 * **The root must be the scroll box.** A list that scrolls inside an
 * `overflow` container never intersects the viewport the way the page does, so
 * an observer with the default root fires once, or never.
 *
 * **The observer is rebuilt whenever the paging state changes.** A new
 * `IntersectionObserver` reports the target's current intersection as soon as
 * it observes. After a page lands, that re-asks "is the foot still in view?".
 * Filters make this necessary: a page whose sessions are all filtered out adds
 * no rows, the sentinel does not move, and a single long-lived observer would
 * never fire again.
 *
 * `loadMore` must be stable (TanStack's `fetchNextPage` is); an inline arrow
 * rebuilds the observer on every render.
 *
 * Pass `hasMore: false` after a failed page load. Otherwise the rebuild fires
 * the same failing request in a loop; the list shows a retry control instead.
 */
export function useLoadMoreSentinel<T extends HTMLElement = HTMLDivElement>({
  rootRef,
  hasMore,
  isLoadingMore,
  loadMore,
}: {
  rootRef: RefObject<HTMLElement | null>;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}): RefObject<T | null> {
  const sentinelRef = useRef<T | null>(null);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || isLoadingMore) return;
    // No observer (jsdom, very old browsers): the list still renders its
    // loaded pages; it only stops extending on scroll.
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (shouldLoadMore(!!entry?.isIntersecting, { hasMore, isLoadingMore })) {
          loadMore();
        }
      },
      { root: rootRef.current, rootMargin: LOAD_MORE_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootRef, hasMore, isLoadingMore, loadMore]);

  return sentinelRef;
}
