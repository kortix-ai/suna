'use client';

import { type Virtualizer, useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type VirtualListSnapshot,
  readSnapshot,
  resolveScrollMargin,
  translateForItem,
  writeSnapshot,
} from './virtual-list-core';

export type { VirtualListSnapshot } from './virtual-list-core';

/**
 * Headless windowed list.
 *
 * The product owns the scroll surface and every element it renders. This hook
 * owns only the arithmetic: which rows are visible, where each one goes, and
 * how to get back to a row by key.
 *
 * ## Why this is a module and not a `useVirtualizer` call at the use site
 *
 * `useVirtualizer` trips `react-hooks/incompatible-library`, which switches
 * React Compiler OFF for the whole component that calls it:
 *
 *     warning  Compilation Skipped: Use of incompatible library
 *              TanStack Virtual's `useVirtualizer()` API returns functions
 *              that cannot be memoized safely
 *
 * PR #6104 called it directly inside `SessionChat` — 4,204 lines — so the
 * compiler stopped memoizing all of it, and the PR then hand-added
 * `useCallback`/`memo` to reinstate by hand what it had just switched off.
 *
 * Consume this hook from the SMALLEST component that renders the rows. The
 * compiler skip is then scoped to that component alone.
 */

interface ElementScroll {
  mode: 'element';
  ref: React.RefObject<HTMLElement | null>;
}

interface WindowScroll {
  mode: 'window';
}

export interface UseVirtualListOptions<TRow> {
  rows: readonly TRow[];
  /** Stable across renders and across a prepend. Never derive it from an index. */
  getRowKey: (row: TRow, index: number) => string;
  /** First guess for an unmeasured row. Real heights replace it on measure. */
  estimateRowHeight: (row: TRow, index: number) => number;
  scroll: ElementScroll | WindowScroll;
  /**
   * Rows kept mounted beyond the viewport on each side.
   *
   * Keep this small. It is multiplied by the row height, so a generous
   * overscan on tall rows quietly re-mounts most of what windowing removed:
   * PR #6104's `overscan: 8` on ~18,000px turns was ~300,000px of live DOM.
   */
  overscan?: number;
  /**
   * Scopes the measurement cache and any restored snapshot. A snapshot from
   * another id is discarded rather than seeding this list with foreign sizes.
   */
  cacheKey: string;
  /** Restores offset + measured sizes from a previous mount. */
  initialSnapshot?: VirtualListSnapshot;
}

export interface VirtualListRow<TRow> {
  key: string;
  index: number;
  row: TRow;
  /** Offset inside the positioned container. Already scroll-margin corrected. */
  translate: number;
}

export interface UseVirtualListResult<TRow> {
  /** The rows to mount, in order. */
  items: VirtualListRow<TRow>[];
  /** Height for the positioned container. */
  totalSize: number;
  /** Attach to every mounted row element. Requires `data-index` on the node. */
  measureRef: (node: HTMLElement | null) => void;
  /** Attach to the positioned container. Drives scroll-margin measurement. */
  containerRef: (node: HTMLElement | null) => void;
  scrollToKey: (key: string, options?: { align?: 'start' | 'center' | 'end' }) => boolean;
  scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' }) => void;
  /**
   * Scroll to the true end of the list.
   *
   * NOT `scrollTop = scrollHeight - clientHeight`. That reads a PROJECTION:
   * rows past the window still carry `estimateRowHeight`, so the number is
   * wrong by however far the estimates are off, and it MOVES as those rows
   * mount and measure. A one-shot target computed from it lands short —
   * measured at 2,833px short on a real session, which is what made the
   * scroll-to-bottom button look broken.
   *
   * virtual-core's `scrollToEnd` re-derives the target every frame until it
   * stops moving (`reconcileScroll`, index.js:1131), which is exactly the
   * behaviour a moving target needs.
   */
  scrollToEnd: (options?: { behavior?: 'auto' | 'smooth' }) => void;
  /** Offset + measured sizes, for restoring this exact position on remount. */
  takeSnapshot: () => VirtualListSnapshot;
}

export function useVirtualList<TRow>({
  rows,
  getRowKey,
  estimateRowHeight,
  scroll,
  overscan = 6,
  cacheKey,
  initialSnapshot,
}: UseVirtualListOptions<TRow>): UseVirtualListResult<TRow> {
  // Read through a ref so `getItemKey`/`estimateSize` can stay referentially
  // stable. Both are dependencies of virtual-core's measurement memo
  // (virtual-core/index.js:558), which compares by identity — an inline arrow
  // there wipes `pendingMin` (:574) and rebuilds the entire size array on
  // EVERY render, so a streamed token costs an O(N) remeasure.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const getRowKeyRef = useRef(getRowKey);
  getRowKeyRef.current = getRowKey;
  const estimateRef = useRef(estimateRowHeight);
  estimateRef.current = estimateRowHeight;

  const getItemKey = useCallback((index: number) => {
    const row = rowsRef.current[index];
    return row === undefined ? index : getRowKeyRef.current(row, index);
  }, []);

  const estimateSize = useCallback((index: number) => {
    const row = rowsRef.current[index];
    return row === undefined ? 0 : estimateRef.current(row, index);
  }, []);

  // ── Scroll margin ───────────────────────────────────────────────────────
  // The container is rarely at the scroller's content origin. virtual-core
  // compares item coordinates against the raw scrollTop (index.js:1213), so a
  // wrong margin shifts the visible range AND makes `scrollToIndex` land short
  // by exactly that distance.
  const containerElRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // `scroll` is a fresh object literal every render, so it can never be a
  // dependency. These two are the parts that actually matter, and both are
  // stable: the mode is fixed for a mount, and the ref object is identity-
  // stable (it comes from a `useRef` in the caller).
  const scrollMode = scroll.mode;
  const scrollElementRef = scroll.mode === 'element' ? scroll.ref : null;

  const measureScrollMargin = useCallback(() => {
    const container = containerElRef.current;
    if (!container) return;
    const scroller = scrollElementRef?.current ?? null;

    const next =
      scroller === null
        ? // Window scrolling: the page itself is the scroller, so the margin is
          // the container's distance from the document origin.
          Math.max(0, Math.round(container.getBoundingClientRect().top + window.scrollY))
        : resolveScrollMargin({
            containerRect: container.getBoundingClientRect(),
            scrollerRect: scroller.getBoundingClientRect(),
            scrollTop: scroller.scrollTop,
          });

    setScrollMargin((current) => (current === next ? current : next));
  }, [scrollElementRef]);

  const containerRef = useCallback(
    (node: HTMLElement | null) => {
      containerElRef.current = node;
      if (node) measureScrollMargin();
    },
    [measureScrollMargin],
  );

  // Everything rendered ABOVE the list changes this: the load-older block
  // appearing, its spinner, and the optimistic turn on every send. Re-measure
  // when any of them resize.
  useLayoutEffect(() => {
    const container = containerElRef.current;
    if (!container) return;

    measureScrollMargin();

    const observer = new ResizeObserver(() => measureScrollMargin());
    const scroller = scrollElementRef?.current ?? null;
    if (scroller) observer.observe(scroller);
    // The container's own offset moves when a PREVIOUS SIBLING resizes — the
    // load-older block appearing, its spinner, the optimistic turn on send.
    // A ResizeObserver on the container itself cannot see any of that, so
    // watch the parent, whose height changes with them.
    if (container.parentElement) observer.observe(container.parentElement);

    return () => observer.disconnect();
  }, [measureScrollMargin, scrollElementRef]);

  // ── Restore ─────────────────────────────────────────────────────────────
  // Frozen at mount by design: re-reading a snapshot mid-life would yank the
  // reader's position out from under them. `SessionChat` is keyed by session
  // id, so a new session is a new mount and gets a fresh read.
  const [restored] = useState(() => readSnapshot(initialSnapshot, cacheKey));

  const shared = {
    count: rows.length,
    estimateSize,
    getItemKey,
    overscan,
    scrollMargin,
    initialOffset: restored?.offset,
    initialMeasurementsCache: restored?.measurements,
  } as const;

  // Both hooks are called unconditionally — `scroll.mode` is fixed for a given
  // mount, and calling one conditionally would break the rules of hooks. The
  // unused one is disabled so it observes nothing.
  const elementVirtualizer = useVirtualizer({
    ...shared,
    enabled: scroll.mode === 'element',
    getScrollElement: () => (scroll.mode === 'element' ? scroll.ref.current : null),
  });
  const windowVirtualizer = useWindowVirtualizer({
    ...shared,
    enabled: scroll.mode === 'window',
  });

  const virtualizer = (scroll.mode === 'element'
    ? elementVirtualizer
    : windowVirtualizer) as unknown as Virtualizer<Element, HTMLElement>;

  // ── Scroll compensation: OFF. `MessageScroller` owns anchoring ──────────
  //
  // virtual-core keeps the picture stable when a measured row size lands by
  // writing an ABSOLUTE `scrollTop = scrollOffset + delta`
  // (applyScrollAdjustment, index.js:1102). `scrollOffset` lags the live scroll
  // position by a frame, so while the reader is scrolling that write lands
  // BEHIND where they already are and undoes part of their own input. That is
  // the reported "the whole thread staggers/shakes when I scroll".
  //
  // Note this is NOT fixed by deleting the assignment. virtual-core's DEFAULT
  // rule (index.js:862-869) compensates unconditionally on an item's FIRST
  // measurement — `!this.itemSizeCache.has(key)` — and in a windowed list a
  // first measurement is exactly what happens to every row the reader scrolls
  // into. Falling back to the default means compensating on nearly every frame
  // of a scroll. It has to be switched off explicitly.
  //
  // Measured on a real session, scrolling up 14,320px: 270 direction reversals
  // with virtual-core's default rule, 0 with compensation disabled.
  //
  // Nothing is lost, because a second anchoring system now exists.
  // `MessageScroller` re-pins against the LIVE element rect rather than a
  // frame-stale offset: `reanchorToAnchoredMessage` holds the anchored row's
  // viewport offset across every content resize, and `handleResize` re-pins the
  // bottom while following a stream. Two systems both correcting the same
  // scrollTop is the fight being removed — so this one stands down.
  //
  // Instance property, not an option (virtual-core index.d.ts:117).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  const virtualItems = virtualizer.getVirtualItems();

  const items = useMemo(
    () =>
      virtualItems.reduce<VirtualListRow<TRow>[]>((acc, item) => {
        const row = rows[item.index];
        // A row can vanish between virtual-core's measurement pass and this
        // render (a rewind drops turns). Skipping beats rendering a hole.
        if (row !== undefined) {
          acc.push({
            key: String(item.key),
            index: item.index,
            row,
            translate: translateForItem(item.start, scrollMargin),
          });
        }
        return acc;
      }, []),
    [virtualItems, rows, scrollMargin],
  );

  const scrollToIndex = useCallback(
    (index: number, options?: { align?: 'start' | 'center' | 'end' }) => {
      // No `behavior: 'smooth'`: TanStack documents smooth scrolling as
      // unreliable once sizes are measured rather than fixed.
      virtualizer.scrollToIndex(index, { align: options?.align ?? 'start' });
    },
    [virtualizer],
  );

  const scrollToKey = useCallback(
    (key: string, options?: { align?: 'start' | 'center' | 'end' }) => {
      const index = rowsRef.current.findIndex((row, i) => getRowKeyRef.current(row, i) === key);
      // False, not a scroll to 0: an unknown key must not throw the reader to
      // the top of the transcript.
      if (index < 0) return false;
      scrollToIndex(index, options);
      return true;
    },
    [scrollToIndex],
  );

  const scrollToEnd = useCallback(
    (options?: { behavior?: 'auto' | 'smooth' }) => {
      virtualizer.scrollToEnd({ behavior: options?.behavior ?? 'auto' });
    },
    [virtualizer],
  );

  const takeSnapshot = useCallback(
    () =>
      writeSnapshot({
        offset: virtualizer.scrollOffset ?? 0,
        items: virtualizer.takeSnapshot(),
        sessionId: cacheKey,
      }),
    [virtualizer, cacheKey],
  );

  // NO `virtualizer.measure()` here. It looks like the right way to react to a
  // new scroll margin and it is destructive:
  //
  //   this.measure = () => {
  //     this.pendingMin = null;
  //     this.itemSizeCache.clear();   // <- every measured row height, gone
  //     ...
  //   }
  //
  // Calling it throws away every height the ResizeObserver has measured, so the
  // whole transcript reverts to `estimateRowHeight` and the projected total
  // COLLAPSES. Measured live: the scrollable height swinging 2,525px while
  // merely scrolling, dropping 200-300px at a time — the scroll range moving
  // under the reader, which is exactly "I cannot scroll smoothly".
  //
  // It is also unnecessary. `scrollMargin` is already a dependency of
  // virtual-core's measurement memo (getMeasurementOptions, index.js:562), so
  // changing it re-derives every item offset from the PRESERVED size cache on
  // its own. The correct reaction to a new margin is to do nothing.

  return {
    items,
    totalSize: virtualizer.getTotalSize(),
    measureRef: virtualizer.measureElement,
    containerRef,
    scrollToKey,
    scrollToIndex,
    scrollToEnd,
    takeSnapshot,
  };
}
