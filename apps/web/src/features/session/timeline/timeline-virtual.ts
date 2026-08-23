/**
 * The virtual turn list's pure rules — no React, no DOM, unit-tested as
 * functions (`timeline-virtual.test.ts`). `session-timeline-list.tsx` owns the
 * `useVirtualizer` wiring; the policy lives here so it has tests that can fail
 * without a browser.
 *
 * ONE ITEM = ONE TURN. The DOM consumers of the transcript (`use-auto-scroll`'s
 * anchor, `session-history-scroll`, the minimap, the jump-to-message lookup)
 * all key on the turn element (`[data-turn-id]`), `TurnFrame` owns the
 * per-turn hooks, and `groupRowsByTurn` already yields a stable per-turn array
 * cached on the rows identity — so the turn is the unit that virtualizes
 * without moving any contract. Row-level items (upstream's `TimelineRow.key`)
 * are a later stage, once the `'none'` slots in `timeline-row-switch.tsx`
 * render real elements.
 *
 * WHO OWNS "THE END". `use-auto-scroll.ts` alone: it sizes the room under the
 * newest turn (the spacer) and settles a following viewport at
 * `scrollHeight − clientHeight`. virtual-core's own notion of the end
 * (`scrollMargin + totalSize − outerSize`) is blind to that room, so the list
 * passes `followOnAppend: false` and `scrollEndThreshold: -1` — which turns
 * `anchorTo: 'end'` into a pure PREPEND/REMOVE anchor (the item at the
 * viewport top keeps its offset when the count or the edge keys change,
 * resolved inside the same commit, before paint) with none of virtual-core's
 * end-following. `shouldAdjustForResize` below is the only other scroll
 * correction the list makes.
 */
import type { VirtualItem } from '@tanstack/react-virtual';

import { turnGapClass } from './turn-gap';

/** The height a turn is assumed to have before it is measured. A bubble plus a
 *  short answer; a tool-heavy turn is many times this and is measured on its
 *  first paint. */
export const TURN_FALLBACK_SIZE = 160;
/** Turns rendered beyond the visible range on each side — the first paint of
 *  a session (`RENDER_OVERSCAN_COLD`, cheaper), then two frames later
 *  (`RENDER_OVERSCAN_WARM`, smoother scrolling). Mirrors upstream's 6 → 20 at
 *  the turn scale (a turn is several upstream rows). */
export const RENDER_OVERSCAN_COLD = 3;
export const RENDER_OVERSCAN_WARM = 6;
/** `overscan` handed to virtual-core. The range extractor overrides it with
 *  the render overscan above; this value only widens the measure-during-
 *  smooth-scroll buffer (upstream passes 50 too). */
export const VIRTUAL_OVERSCAN = 50;
/** Measurement snapshots kept across session switches (upstream: 16). */
export const MEASUREMENT_SNAPSHOTS_MAX = 16;

// ============================================================================
// The API the host reads (jump-to-message, minimap, history)
// ============================================================================

export interface TimelineVirtualApi {
  /** The turn's index in the list, or `undefined` for an unknown id. */
  turnIndex(turnId: string): number | undefined;
  /** The turn's top in the scroll container's content space (px), `undefined`
   *  for an unknown id. Equals the `[data-turn-id]` element's content-space
   *  top while the turn is mounted. */
  turnStart(turnId: string): number | undefined;
  /** The turn whose item contains content-space `offset` (the nearest start at
   *  or above it), `undefined` for an empty list. */
  turnAtOffset(offset: number): string | undefined;
  /** Is the turn's element in the DOM right now? */
  isMounted(turnId: string): boolean;
  /**
   * Scroll the turn into view. `align: 'start'` (default) lands its top
   * `TURN_TOP_OFFSET` under the viewport top — the legacy `offset − 24`.
   * Re-targets over the following frames as the turns above it get measured.
   * `false` for an unknown id.
   */
  scrollToTurn(
    turnId: string,
    options?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: ScrollBehavior },
  ): boolean;
  /** Drop every measured size and re-measure the mounted turns. */
  measure(): void;
}

/**
 * Injected by tests and the bench, where the DOM has no layout: the viewport
 * rect, how to observe it, how a turn is measured, how a scroll is applied.
 * Never set by the app.
 */
export interface TimelineVirtualSeam {
  initialRect?: { width: number; height: number };
  observeElementRect?: (
    instance: unknown,
    cb: (rect: { width: number; height: number }) => void,
  ) => void | (() => void);
  observeElementOffset?: (
    instance: unknown,
    cb: (offset: number, isScrolling: boolean) => void,
  ) => void | (() => void);
  measureElement?: (
    element: Element,
    entry: ResizeObserverEntry | undefined,
    instance: unknown,
  ) => number;
  scrollToFn?: (
    offset: number,
    options: { adjustments?: number; behavior?: ScrollBehavior },
    instance: unknown,
  ) => void;
}

// ============================================================================
// Gap below a turn (virtual mode)
// ============================================================================

/**
 * In the flat list the space BEFORE a turn is the turn's own top margin
 * (`turnGapClass`: `mt-3` stacked pending, `mt-12` otherwise). A margin is
 * outside the box the virtualizer measures and it would sit between the
 * item's `start` and the turn element's top, so `scrollToIndex` would land
 * `gap` px high and `turnStart` would not equal the element's top.
 *
 * The virtual list therefore puts the SAME space at the bottom of the
 * PREVIOUS item, as padding inside the measured box: turn `j` gets the gap
 * that turn `j + 1` would have carried on top. Geometry is identical — the
 * distance from a turn's top to the next turn's top, and from the anchor turn
 * to the spacer (`use-auto-scroll`'s room), does not change — and an item's
 * `start` IS its turn element's top.
 */
export function turnGapBelowClass(input: {
  /** Index of THIS turn. */
  index: number;
  count: number;
  userMessageID: string;
  nextUserMessageID: string | undefined;
  lastTurnWorking: boolean;
  pendingTurnIds: ReadonlySet<string>;
}): '' | 'pb-3' | 'pb-12' {
  if (input.index >= input.count - 1 || input.nextUserMessageID === undefined) return '';
  const above = turnGapClass({
    index: input.index + 1,
    userMessageID: input.nextUserMessageID,
    previousUserMessageID: input.userMessageID,
    lastTurnWorking: input.lastTurnWorking,
    pendingTurnIds: input.pendingTurnIds,
  });
  if (above === 'mt-3') return 'pb-3';
  if (above === 'mt-12') return 'pb-12';
  return '';
}

// ============================================================================
// Scroll correction on resize
// ============================================================================

/** `use-auto-scroll` mirrors its follow bit onto the scroll element. */
export function isFollowing(scrollElement: { dataset?: DOMStringMap } | null | undefined): boolean {
  return scrollElement?.dataset?.follow === 'true';
}

/**
 * When a mounted turn's measured size changes, should the virtualizer move
 * `scrollTop` by the delta?
 *
 * - Following: NO. `use-auto-scroll` puts the viewport back at the end after
 *   every layout change; a second correction here would fight it.
 * - Not following: only for a turn ABOVE the visible range — its growth would
 *   otherwise push the reader's content down the screen. A turn inside or
 *   below the range grows away from the reader. (Upstream L491-495.)
 */
export function shouldAdjustForResize(input: {
  following: boolean;
  itemIndex: number;
  rangeStartIndex: number | undefined;
}): boolean {
  if (input.following) return false;
  if (input.rangeStartIndex === undefined) return false;
  return input.itemIndex < input.rangeStartIndex;
}

// ============================================================================
// Which turns are always mounted
// ============================================================================

/**
 * Turns that stay in the DOM wherever the reader is: the LAST turn
 * (`use-auto-scroll` sizes the room from the newest turn; a room sized with no
 * anchor is a whole viewport and would re-size on arrival at the end), the
 * WORKING turn and every PENDING / INTERRUPTED bubble behind it (the anchor
 * turn is "the last turn without a pending descendant" — it must exist). They
 * are the tail of the list, so this is a handful of indexes.
 */
export function pinnedTurnIndexes(input: {
  count: number;
  indexById: ReadonlyMap<string, number>;
  workingTurnId: string | null;
  pendingTurnIds: ReadonlySet<string>;
  interruptedTurnIds: ReadonlySet<string>;
}): number[] {
  const out = new Set<number>();
  if (input.count > 0) out.add(input.count - 1);
  const add = (id: string) => {
    const index = input.indexById.get(id);
    if (index !== undefined) out.add(index);
  };
  if (input.workingTurnId) add(input.workingTurnId);
  for (const id of input.pendingTurnIds) add(id);
  for (const id of input.interruptedTurnIds) add(id);
  return [...out].sort((a, b) => a - b);
}

/**
 * The indexes to render: the visible range widened by `renderOverscan` on each
 * side, plus every pinned index, clamped to `[0, count)`, unique, ascending.
 * (Upstream `filterVirtualIndexes` over `defaultRangeExtractor`.)
 */
export function timelineRangeIndexes(
  range: { startIndex: number; endIndex: number; count: number },
  renderOverscan: number,
  pinned: readonly number[],
): number[] {
  const out = new Set<number>();
  const start = Math.max(range.startIndex - renderOverscan, 0);
  const end = Math.min(range.endIndex + renderOverscan, range.count - 1);
  for (let i = start; i <= end; i++) out.add(i);
  for (const i of pinned) {
    if (Number.isInteger(i) && i >= 0 && i < range.count) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

// ============================================================================
// Measurement snapshots across session switches
// ============================================================================

const snapshots = new Map<string, VirtualItem[]>();

/** Remember the measured sizes of a session's turns (LRU, capped). */
export function rememberTimelineMeasurements(sessionId: string, items: VirtualItem[]): void {
  snapshots.delete(sessionId);
  if (items.length === 0) return;
  snapshots.set(sessionId, items);
  while (snapshots.size > MEASUREMENT_SNAPSHOTS_MAX) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

/** The sizes remembered for a session, for `initialMeasurementsCache`. */
export function recallTimelineMeasurements(sessionId: string): VirtualItem[] | undefined {
  return snapshots.get(sessionId);
}

export const __testing = {
  clearSnapshots(): void {
    snapshots.clear();
  },
};
