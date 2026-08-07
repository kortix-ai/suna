'use client';

import { useEffect, useRef } from 'react';

import { useCapabilityScrollRoot } from '@/features/workspace/capabilities/shared/capability-scroll-root';

import { shouldLoadOnScroll } from './catalog-paging';

/**
 * How far below the fold the sentinel starts working.
 *
 * 400px is roughly four card-rows of lead time at this grid's 84px row height
 * (`catalog-grid-tokens.ts`), so the next batch is usually in hand before the
 * user reaches the bottom and the grid grows without ever showing its end.
 * Reactive loading — firing at 0px — is what makes infinite scroll stutter.
 */
const SENTINEL_ROOT_MARGIN = '400px';

/**
 * The nearest scrollable ancestor of `node`, or `null` for the viewport.
 *
 * A fallback for `useCapabilityScrollRoot` returning nothing — a catalogue
 * rendered outside a `CapabilityPageShell`, or a shell whose ref has not
 * attached. `IntersectionObserver` treats `root: null` as the viewport, and a
 * viewport root is not a degraded mode here, it is a broken one: the
 * `(capabilities)` layout clips the shell with `overflow-hidden`, so a sentinel
 * inside it never intersects the viewport and the observer never fires. Silently.
 * Finding the scroll box from the DOM cannot go wrong the way a ref handoff can.
 */
function nearestScrollParent(node: Element | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
  }
  return null;
}

/**
 * Infinite scroll for the catalogue grid: attach the returned ref to a marker
 * at the foot of the list and reaching it loads more.
 *
 * **The root is the shell, not the viewport** — see `nearestScrollParent`.
 *
 * **Why the root is resolved inside this effect.** It used to be resolved in a
 * `useLayoutEffect` into state, and that was a real bug that shipped: React
 * attaches host refs and runs layout effects in ONE depth-first pass, children
 * before parents, so an ancestor's ref is still `null` when a descendant's
 * layout effect runs. The resolved value was therefore `null`; `setState(null)`
 * on already-`null` state bails out without re-rendering; and the effect's only
 * dep was the ref object, which never changes. The root stayed `null` forever
 * and the observer watched a viewport this sentinel cannot intersect. Passive
 * effects run after the whole commit, by which point every ref is attached.
 *
 * **Why the observer is rebuilt when the query state changes.** A fresh
 * `IntersectionObserver` reports the target's CURRENT intersection as soon as
 * it observes, so re-creating it after a batch lands re-asks "is the foot still
 * in view?". That is what keeps a filtered category deepening: when a landed
 * page adds no cards to the category on screen, the sentinel does not move, no
 * transition occurs, and a single long-lived observer would go quiet with the
 * user still staring at eight cards.
 */
export function useCatalogAutoload({
  hasMore,
  isLoadingMore,
  loadMore,
}: {
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollRootRef = useCapabilityScrollRoot();

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    // jsdom and older browsers have no observer. Without this the hook throws
    // on mount and takes the whole grid with it; the "Load more" button in the
    // footer is the working fallback, and it is always rendered.
    if (typeof IntersectionObserver === 'undefined') return;

    const root = scrollRootRef.current ?? nearestScrollParent(node);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (shouldLoadOnScroll(!!entry?.isIntersecting, { hasMore, isLoadingMore })) {
          loadMore();
        }
      },
      { root, rootMargin: SENTINEL_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRootRef, hasMore, isLoadingMore, loadMore]);

  return sentinelRef;
}
