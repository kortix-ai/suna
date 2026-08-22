'use client';

import { useId } from 'react';

import Loading from '@/components/ui/loading';
import { STATUS_RING, STATUS_RING_OUTER_RADIUS } from '@/components/ui/status-ring';
import { cn } from '@/lib/utils';

export interface TodoItem {
  content: string;
  status: 'completed' | 'in_progress' | 'pending' | 'cancelled';
  priority?: string;
}

export function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const content = (raw as any).content;
    if (typeof content !== 'string' || !content.trim()) return [];
    const s = (raw as any).status;
    const status: TodoItem['status'] =
      s === 'completed' || s === 'in_progress' || s === 'cancelled' ? s : 'pending';
    return [{ content, status, priority: (raw as any).priority }];
  });
}

// ============================================================================
// One geometry, four states
// ============================================================================
//
// Every glyph below is drawn on `STATUS_RING` — see that module for why, and
// for the four different circles this replaced.

/** Marks drawn INSIDE a filled disc (the check, the cancel bar). Slightly
 *  heavier than the ring stroke: a knockout on a solid field loses apparent
 *  weight to the surrounding ink, so 1.5 here would read thinner than the 1.5
 *  of the pending ring beside it. */
const MARK_STROKE = 1.75;

/**
 * The check, in glyph units. Spans x 4.4 → 11.6 — 7.2 units, 51% of the
 * 14.1-unit disc, stroked at 1.75.
 *
 * Phosphor's `CheckCircle` fill (the glyph this replaces) draws its mark across
 * ~80 of its 256-unit box at a ~16-unit stroke. Rendered at `size-4` that is a
 * 5.0px mark at 1.0px; this one is 7.2px at 1.75px — 44% wider and 75% heavier,
 * inside a disc that is itself 13.0px → 14.1px. That is the whole "the check
 * icon looks small" complaint, measured.
 */
const CHECK_PATH = 'M4.4 8.3 L6.9 10.8 L11.6 5.2';

/**
 * Optical seat for the check. Its two strokes converge at the bottom vertex, so
 * the ink centroid sits ~0.5 units BELOW the bounding box centre and the mark
 * reads low inside a perfectly centred disc. Half the error is the usual
 * correction; the other half keeps the tail from crowding the rim.
 */
const CHECK_OPTICAL_LIFT = 'translate(0 -0.25)';

/** The cancel bar. Same 45° as Phosphor's Prohibit, sized to the same span as
 *  the check so the two terminal states carry equal visual weight. */
const CANCEL_PATH = 'M5.1 10.9 L10.9 5.1';

/** A filled disc with `path` punched out of it. A knockout, not a coloured
 *  stroke: the mark then shows whatever is actually behind the glyph — the row
 *  hover tint, a selected row, a themed surface — instead of hard-coding
 *  `--background` and going wrong the moment the surface is not that. */
function KnockoutDisc({
  path,
  transform,
  className,
  maskId,
}: {
  path: string;
  transform?: string;
  className?: string;
  maskId: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${STATUS_RING.BOX} ${STATUS_RING.BOX}`}
      fill="none"
      aria-hidden
      className={className}
    >
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width={STATUS_RING.BOX}
        height={STATUS_RING.BOX}
      >
        <circle
          cx={STATUS_RING.CENTER}
          cy={STATUS_RING.CENTER}
          r={STATUS_RING_OUTER_RADIUS}
          fill="#fff"
        />
        <path
          d={path}
          transform={transform}
          stroke="#000"
          strokeWidth={MARK_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </mask>
      <circle
        cx={STATUS_RING.CENTER}
        cy={STATUS_RING.CENTER}
        r={STATUS_RING_OUTER_RADIUS}
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}

/**
 * `className` overrides the per-status tint AND the size — every state is one
 * `<svg>` with no intrinsic `width`/`height`, so `size-[18px]` scales the whole
 * family (this is how `plan-card.tsx` grows the rail).
 *
 * It exists for ONE other reason worth knowing about: `Loading` carries
 * `in-[button]:text-background`, so an `in_progress` glyph rendered inside a
 * `<button>` — a disclosure trigger, a summary row — silently repaints itself in
 * the page background and disappears. `cn()` cannot save you there: twMerge only
 * dedupes within a variant group, and `in-[button]:text-background` is prefixed,
 * so it never collides with the tint passed here. Callers inside a button must
 * pass an `!` important colour (or set `bg-transparent` on the button, which is
 * `Loading`'s own escape hatch).
 */
export function TodoStatusIcon({
  status,
  className,
}: {
  status: TodoItem['status'];
  className?: string;
}) {
  // Unconditional: hooks cannot live inside the switch below. `useId` emits
  // colons, legal in an HTML id but hostile inside a `url(#…)` reference.
  const maskId = `todo-glyph-${useId().replace(/:/g, '')}`;
  const size = 'size-4 shrink-0';

  switch (status) {
    case 'completed':
      return (
        <KnockoutDisc
          maskId={maskId}
          path={CHECK_PATH}
          transform={CHECK_OPTICAL_LIFT}
          className={cn('text-kortix-green', size, className)}
        />
      );

    case 'in_progress':
      // The `ring` variant is this exact geometry, arc-animated — so the running
      // state is the pending ring in motion, not a second, fatter circle.
      return (
        <Loading variant="ring" className={cn('text-kortix-orange', size, className)} />
      );

    case 'cancelled':
      return (
        <KnockoutDisc
          maskId={maskId}
          path={CANCEL_PATH}
          className={cn('text-muted-foreground/40', size, className)}
        />
      );

    case 'pending':
      return (
        <svg
          viewBox={`0 0 ${STATUS_RING.BOX} ${STATUS_RING.BOX}`}
          fill="none"
          strokeLinejoin="round"
          aria-hidden
          className={cn('text-muted-foreground', size, className)}
        >
          <circle
            cx={STATUS_RING.CENTER}
            cy={STATUS_RING.CENTER}
            r={STATUS_RING.RADIUS}
            stroke="currentColor"
            fill="none"
            strokeWidth={STATUS_RING.STROKE}
            strokeDasharray={`${STATUS_RING.DASH} ${STATUS_RING.GAP}`}
          />
        </svg>
      );

    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
