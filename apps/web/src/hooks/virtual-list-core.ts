/**
 * Pure arithmetic behind `useVirtualList`.
 *
 * Split from the hook because apps/web renders component tests through
 * `renderToStaticMarkup` — there is no RTL, jsdom or happy-dom in the
 * dependency set, so nothing that scrolls or measures can be asserted in a
 * test. Everything that can be a plain function is one, and lives here.
 *
 * No React, no DOM access (callers pass measured rects in).
 */

import type { VirtualItem } from '@tanstack/react-virtual';

// ---------------------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------------------

/**
 * The `translateY` for a virtual item.
 *
 * virtual-core seeds item coordinates with `scrollMargin`
 * (virtual-core/index.js:645) but `getTotalSize()` subtracts it back out
 * (:1063), so the positioned container never carries the lead-in. The item's
 * offset inside that container is therefore `start - scrollMargin` — the same
 * formula react-virtual's own helper uses.
 *
 * A bare `start` is correct only while the margin is 0. That is the trap: it
 * looks right until the day someone sets a real `scrollMargin`, and then every
 * row is pushed down by it.
 */
export function translateForItem(start: number, scrollMargin: number): number {
  return Math.max(0, start - scrollMargin);
}

// ---------------------------------------------------------------------------
// Scroll margin
// ---------------------------------------------------------------------------

export interface ScrollMarginInput {
  /** `getBoundingClientRect()` of the element holding the virtual rows. */
  containerRect: Pick<DOMRect, 'top'>;
  /** `getBoundingClientRect()` of the scroll element. */
  scrollerRect: Pick<DOMRect, 'top'>;
  /** The scroller's current `scrollTop`. */
  scrollTop: number;
}

/**
 * How far the virtualized container sits below the top of the scroller's
 * content.
 *
 * virtual-core compares item coordinates against the RAW `scrollTop`
 * (index.js:1213). When the list does not start at the scroller's content
 * origin, that comparison is off by this distance: the visible range is
 * computed for the wrong window, and `scrollToIndex` (index.js:951) lands short
 * by exactly this many pixels.
 *
 * Adding `scrollTop` back makes the result independent of where the reader is,
 * so the value only changes when the DOM above the list actually changes —
 * which it does, on every load-older pull and every optimistic send.
 */
export function resolveScrollMargin({
  containerRect,
  scrollerRect,
  scrollTop,
}: ScrollMarginInput): number {
  // Rounded: a sub-pixel delta would otherwise re-seed the virtualizer's
  // measurement memo on every layout pass and rebuild the whole size array.
  return Math.max(0, Math.round(containerRect.top - scrollerRect.top + scrollTop));
}

// ---------------------------------------------------------------------------
// Row height estimates
// ---------------------------------------------------------------------------

/**
 * First guess for an unmeasured row, per kind.
 *
 * Taken from a real session (`e025cf03`): 324 segments totalling 15,198px —
 * median 24px, mean 47px — under a 248px head and a 97px tail.
 *
 * One constant for every kind is what made PR #6104's `getTotalSize()` fiction:
 * 600px against items that measured 17,944px.
 */
const ROW_HEIGHT_ESTIMATES = {
  'turn-head': 248,
  segment: 48,
  'turn-tail': 96,
  // A whole turn in one row (shell mode / compaction card). Both are compact
  // and fixed-ish, unlike the turns the row model splits.
  'turn-single': 160,
} as const satisfies Record<string, number>;

export type EstimableRowKind = keyof typeof ROW_HEIGHT_ESTIMATES;

export function estimateRowHeight(row: { kind: EstimableRowKind }): number {
  return ROW_HEIGHT_ESTIMATES[row.kind];
}

// ---------------------------------------------------------------------------
// Snapshot / restore
// ---------------------------------------------------------------------------

export interface VirtualListSnapshot {
  offset: number;
  /**
   * Straight from virtual-core's own `takeSnapshot()` (index.d.ts:188), which
   * returns exactly what `initialMeasurementsCache` consumes.
   *
   * Carried verbatim on purpose. Reconstructing `start` from a running total of
   * sizes looks equivalent and is not: the library also accounts for
   * `paddingStart`, `scrollMargin` and lanes, so a hand-rolled total drifts from
   * what the virtualizer will compute on restore.
   */
  measurements: VirtualItem[];
  /** Guards against seeding one session's cache from another's. */
  sessionId: string;
}

export function writeSnapshot(input: {
  offset: number;
  items: readonly VirtualItem[];
  sessionId: string;
}): VirtualListSnapshot {
  return {
    offset: input.offset,
    measurements: [...input.items],
    sessionId: input.sessionId,
  };
}

export interface RestoredSnapshot {
  offset: number;
  /** For virtual-core's `initialMeasurementsCache` (index.d.ts:78). */
  measurements: VirtualItem[];
}

/**
 * Read a snapshot back, or null when there is nothing usable.
 *
 * Null — rather than an empty cache — distinguishes "start fresh" from
 * "restore a transcript nobody has scrolled yet", which is a real state: the
 * offset matters even when no row has been measured.
 */
export function readSnapshot(
  snapshot: VirtualListSnapshot | undefined,
  sessionId: string,
): RestoredSnapshot | null {
  if (!snapshot) return null;
  if (snapshot.sessionId !== sessionId) return null;

  return { offset: snapshot.offset, measurements: snapshot.measurements };
}
