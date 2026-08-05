'use client';

import {
  type VirtualItem,
  type Virtualizer,
  useVirtualizer,
  useWindowVirtualizer,
} from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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

  const virtualizer = (
    scroll.mode === 'element' ? elementVirtualizer : windowVirtualizer
  ) as unknown as Virtualizer<Element, HTMLElement>;

  // ── Streaming growth must not drag the reader ───────────────────────────
  // virtual-core's default rule (index.js:869) treats a grown item as being
  // above the viewport and adds `delta` to scrollTop. For a row whose content
  // is streaming in at its TAIL, the correct compensation is zero — the growth
  // is below the reader. Because the correction is a DOWNWARD programmatic
  // scroll, none of useAutoScroll's intent detectors observe it, so the
  // viewport creeps toward the end while the reader is trying to read.
  //
  // The precise rule: only a row that ends at or above the current offset can
  // displace what follows it.
  //
  // This is an instance property, not an option (virtual-core index.d.ts:117),
  // so it is assigned rather than passed.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = useCallback(
    (item: VirtualItem, _delta: number, instance: Virtualizer<Element, HTMLElement>) =>
      item.end <= instance.scrollOffset!,
    [],
  );

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
      const index = rowsRef.current.findIndex(
        (row, i) => getRowKeyRef.current(row, i) === key,
      );
      // False, not a scroll to 0: an unknown key must not throw the reader to
      // the top of the transcript.
      if (index < 0) return false;
      scrollToIndex(index, options);
      return true;
    },
    [scrollToIndex],
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

  // A changed scroll margin invalidates every item offset. Re-measure so the
  // range is recomputed against the new origin instead of the stale one.
  useEffect(() => {
    virtualizer.measure();
  }, [scrollMargin, virtualizer]);

  return {
    items,
    totalSize: virtualizer.getTotalSize(),
    measureRef: virtualizer.measureElement,
    containerRef,
    scrollToKey,
    scrollToIndex,
    takeSnapshot,
  };
}
