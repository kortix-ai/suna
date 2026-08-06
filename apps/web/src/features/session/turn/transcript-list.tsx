'use client';

import { useCallback, useEffect, useRef } from 'react';

import { MessageScrollerItem } from '@/components/ui/message-scroller';
import { useVirtualList, type VirtualListSnapshot } from '@/hooks/use-virtual-list';
import { estimateRowHeight } from '@/hooks/virtual-list-core';
import { cn } from '@/lib/utils';

import type { TranscriptRow } from './transcript-rows';

/**
 * The windowed transcript.
 *
 * Deliberately the SMALLEST component that calls `useVirtualList`.
 * `react-hooks/incompatible-library` switches React Compiler off for whichever
 * component calls into TanStack Virtual — PR #6104 called it inside the
 * 4,204-line `SessionChat`, so the compiler stopped memoizing all of it. Keeping
 * the call here confines that to this file.
 *
 * Markup lives here, in product code, not in the hook: the hook returns which
 * rows to mount and where to put them, and nothing else.
 */

interface TranscriptListProps {
  rows: readonly TranscriptRow[];
  /** The scroll container. Owned by the caller — it is `MessageScrollerViewport`. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Scopes the measurement cache. A session id. */
  cacheKey: string;
  initialSnapshot?: VirtualListSnapshot;
  renderRow: (row: TranscriptRow) => React.ReactNode;
  /** Notifies the caller which rows are mounted, so observers can re-arm. */
  onMountedKeysChange?: (keys: string[]) => void;
  /**
   * Receives the scroll API.
   *
   * A ref rather than a returned value because the virtualizer has to live in
   * this component — `react-hooks/incompatible-library` disables React
   * Compiler for whichever component calls into TanStack Virtual, and
   * `SessionChat` is 4,204 lines. Jump-to-message and the load-older anchor
   * restore both live up there and need to reach it.
   */
  apiRef?: React.MutableRefObject<TranscriptListApi | null>;
}

export interface TranscriptListApi {
  /** Brings a row into view. False when the key is not in the list. */
  scrollToKey: (key: string, options?: { align?: 'start' | 'center' | 'end' }) => boolean;
  /** Brings a TURN into view by scrolling to the row it starts with. */
  scrollToTurn: (turnId: string) => boolean;
  /** Scrolls to the true end, re-deriving the target as rows measure. */
  scrollToEnd: (options?: { behavior?: 'auto' | 'smooth' }) => void;
  takeSnapshot: () => VirtualListSnapshot;
}

const getRowKey = (row: TranscriptRow) => row.key;

/**
 * FIXED per-kind estimate, deliberately not a learned one.
 *
 * A learning estimator is destabilizing here: when the estimate changes, every
 * UNMEASURED row's size changes with it, which shifts the start offset of every
 * row after it. Rows above the viewport shifting is exactly what makes
 * virtual-core apply a scroll correction — and that correction is the content
 * jumping under the reader. A fixed estimate means an unmeasured row's size
 * never moves until it is genuinely measured.
 */
const estimate = (row: TranscriptRow) => estimateRowHeight(row);

export function TranscriptList({
  rows,
  scrollRef,
  cacheKey,
  initialSnapshot,
  renderRow,
  onMountedKeysChange,
  apiRef,
}: TranscriptListProps) {
  const { items, measureRef, containerRef, scrollToKey, scrollToEnd, takeSnapshot } =
    useVirtualList({
      rows,
      getRowKey,
      estimateRowHeight: estimate,
      scroll: { mode: 'element', ref: scrollRef },
      // Rows are ~48px, not ~18,000px. Six each side is ~290px of lead-in —
      // enough that a fast flick does not show blank space, small enough that
      // it does not re-mount what windowing just removed.
      overscan: 6,
      cacheKey,
      initialSnapshot,
    });

  // ── Cross-row turn hover ────────────────────────────────────────────────
  // A turn's head and tail are separate virtual rows with no shared ancestor,
  // so `group-hover/turn` can no longer reach from one to the other: hovering
  // a segment would stop revealing the action bar in the tail.
  //
  // Delegated, and written straight to the DOM. Hover is a per-pointer-move
  // signal; routing it through React state would re-render the whole windowed
  // list on every mouse move.
  const hoveredTurnRef = useRef<string | null>(null);

  const applyHover = useCallback((container: HTMLElement, turnId: string | null) => {
    if (hoveredTurnRef.current === turnId) return;
    hoveredTurnRef.current = turnId;
    for (const el of container.querySelectorAll<HTMLElement>('[data-turn-id]')) {
      if (turnId !== null && el.getAttribute('data-turn-id') === turnId) {
        el.setAttribute('data-turn-hovered', '');
      } else {
        el.removeAttribute('data-turn-hovered');
      }
    }
  }, []);

  const handlePointerOver = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-turn-id]');
      applyHover(event.currentTarget, row?.getAttribute('data-turn-id') ?? null);
    },
    [applyHover],
  );

  const handlePointerLeave = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      applyHover(event.currentTarget, null);
    },
    [applyHover],
  );

  // ── Tell the caller which rows are mounted ──────────────────────────────
  // The minimap arms an IntersectionObserver over the turns in the DOM. When
  // rows mount and unmount as the reader scrolls, an observer armed once
  // never sees the ones that arrive later and its highlight freezes.
  //
  // Keyed on the joined key list, so it fires when the mounted SET changes and
  // NOT on a streamed token — which leaves the set untouched.
  const mountedKeys = items.map((item) => item.key).join('\n');
  const lastNotifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedRef.current === mountedKeys) return;
    lastNotifiedRef.current = mountedKeys;
    onMountedKeysChange?.(mountedKeys === '' ? [] : mountedKeys.split('\n'));
  }, [mountedKeys, onMountedKeysChange]);

  // ── Scroll API ──────────────────────────────────────────────────────────
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      scrollToKey,
      scrollToTurn: (turnId) => {
        // The row a turn STARTS with. Scrolling to any other row of that turn
        // would land the reader mid-response.
        const start = rowsRef.current.find(
          (row) =>
            row.turnId === turnId && (row.kind === 'turn-head' || row.kind === 'turn-single'),
        );
        return start ? scrollToKey(start.key, { align: 'start' }) : false;
      },
      scrollToEnd,
      takeSnapshot,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, scrollToKey, scrollToEnd, takeSnapshot]);

  const lastRowKey = rows.length > 0 ? rows[rows.length - 1].key : null;

  return (
    <div
      ref={containerRef}
      // NO `style={{ height: totalSize }}`. Under `directDomUpdates` the
      // virtualizer writes the container height itself; setting it here too
      // means React and the virtualizer overwrite each other every frame.
      className="relative w-full"
      onPointerOver={handlePointerOver}
      onPointerLeave={handlePointerLeave}
    >
      {items.map(({ key, index, row }) => (
        <MessageScrollerItem
          key={key}
          // The scroller's anchoring unit is the ROW, keyed exactly as the
          // virtualizer keys it — `scrollToMessage('<turnId>:head')`. Anything
          // else would need a second id space to translate between.
          messageId={key}
          // Only the row a turn STARTS with is an anchor. Marking every row
          // would make "the message you are reading" flip to a tool call
          // halfway down a response, and `last-anchor` would restore to the
          // tail of the thread instead of the top of its last turn.
          scrollAnchor={row.kind === 'turn-head' || row.kind === 'turn-single'}
          // Dynamic measurement. Without this every row keeps its estimate
          // forever, `getTotalSize()` stays fiction and the scrollbar lies.
          ref={measureRef}
          // Required by virtual-core's `measureElement`, which resolves the
          // index from this attribute (indexFromElement). Missing it makes
          // every measurement a silent no-op.
          data-index={index}
          data-row-key={key}
          // The inter-turn gap is PADDING ON THIS WRAPPER, and `data-turn-id`
          // sits on the inner element below — so the gap is inside the
          // measured item (the virtualizer needs that; margins are excluded
          // from borderBoxSize) but OUTSIDE the rect every anchor reads.
          //
          // PR #6104 put both on one element and switched `mt-12` to `pt-12`,
          // which silently added 48px to `measureTarget`, `recalcSpacer`,
          // `anchorTurn` and the minimap's jump — every anchor parked 48px low.
          // Gaps are per-row padding, reproducing exactly what the two
          // `space-y-*` wrappers used to give. They cannot stay `space-y-*`:
          // Tailwind v4 compiles those to `:not(:last-child)`, so a windowed
          // subset silently loses one gap and the measured row sizes stop
          // summing to the container height.
          //
          // The old nesting was `group/turn space-y-2.5` (10px, between the
          // turn's top-level parts) wrapping a `space-y-2` (8px, between
          // segments). Flattening to rows has to preserve BOTH, or the
          // transcript drifts a couple of px per turn against `main`.
          className={cn(
            'absolute top-0 left-0 w-full',
            // Cancels `MessageScrollerItem`'s own `[content-visibility:auto]
            // [contain-intrinsic-size:auto_10rem]`. That pair is upstream's
            // windowing for a NON-virtualized list, and it is silently fatal
            // here: with `content-visibility: auto` an off-screen row skips
            // layout and reports the 10rem intrinsic placeholder, so
            // `measureElement` writes 160px into the size cache for a row that
            // is nothing of the sort. Every offset after it is then wrong, the
            // projected total is fiction, and the scrollbar lies.
            //
            // `cn` is tailwind-merge and both are arbitrary properties, so
            // these replace rather than stack — asserted in the twMerge group
            // for `[content-visibility:…]` / `[contain-intrinsic-size:…]`.
            '[contain-intrinsic-size:none] [content-visibility:visible]',
            row.kind === 'turn-head' || row.kind === 'turn-single'
              ? // The inter-turn gap. First turn sits flush with the top.
                row.turnIndex === 0
                ? ''
                : 'pt-12'
              : row.kind === 'turn-tail' || (row.kind === 'segment' && row.segIndex === 0)
                ? // Boundaries the old `space-y-2.5` owned: head -> first
                  // segment, and last segment -> tail.
                  'pt-2.5'
                : // Between segments: the old `space-y-2`.
                  'pt-2',
          )}
        >
          <div
            // On EVERY row. The minimap's IntersectionObserver highlights the
            // turn the reader is looking at; a long turn's head row unmounts
            // as soon as they scroll past it, so marking only the head would
            // lose the highlight for the rest of that turn.
            data-turn-id={row.turnId}
            // Only on the row a turn STARTS with. Anchoring — the post-send
            // anchor, the minimap jump, the load-older restore — means "put
            // the top of this turn at the top of the viewport", so it needs
            // the one element per turn that `data-turn-id` used to be.
            data-turn-start={
              row.kind === 'turn-head' || row.kind === 'turn-single' ? row.turnId : undefined
            }
            // Marks the transcript's TRUE final row. "Last node in the DOM" is
            // a different thing once rows are windowed, so anything that needs
            // the real tail reads this attribute rather than the last child.
            data-last-turn={row.key === lastRowKey ? '' : undefined}
            className="group/turn"
          >
            {renderRow(row)}
          </div>
        </MessageScrollerItem>
      ))}
    </div>
  );
}
