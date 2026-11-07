'use client';

import type { SessionDisplayStatus } from '../../session/actions/session-label';
import { ClockCounterClockwiseIcon, GitDiffIcon, QuestionIcon, TargetIcon } from '@phosphor-icons/react';

/**
 * Color says who acts: gray nobody, green the agent, blue you (yellow once it waits
 * over 24h), red broken.
 * `starting` draws the stopped ring: a wake is meant to be instant, so it gets
 * no state of its own, and blue and yellow stay reserved for `needs-you`.
 */
const RING_STATUS_STYLE: Record<
  'starting' | 'stopped' | 'failed',
  { color: string; fill: boolean }
> = {
  starting: { color: 'var(--muted-foreground)', fill: false },
  stopped: { color: 'var(--muted-foreground)', fill: false },
  failed: { color: 'var(--kortix-red)', fill: true },
};

const DOT_COUNT = 8;
const DOT_RADIUS = 6;

const DOTS = Array.from({ length: DOT_COUNT }, (_, i) => {
  const angle = (i * 2 * Math.PI) / DOT_COUNT;
  return { cx: 8 + DOT_RADIUS * Math.sin(angle), cy: 8 - DOT_RADIUS * Math.cos(angle) };
});

/** Behind the arc, clockwise: each dash fainter, so the still glyph reads as
 *  turning. Nothing animates: many rows can be working at once. */
const WORKING_TRAIL = [
  { d: 'M2.84 4.39 A6.3 6.3 0 0 1 4.39 2.84', opacity: 0.85 },
  { d: 'M1.8 9.1 A6.3 6.3 0 0 1 1.8 6.9', opacity: 0.55 },
  { d: 'M4.39 13.16 A6.3 6.3 0 0 1 2.84 11.61', opacity: 0.25 },
];

const GREEN_GLYPH = {
  height: '16',
  width: '16',
  viewBox: '0 0 16 16',
  style: { color: 'var(--kortix-green)' },
  className: 'shrink-0',
  'aria-hidden': true,
} as const;

/** `done` (agent idle, ready for a prompt): the dot ring filled with a core. */
function ReadyGlyph() {
  return (
    <svg {...GREEN_GLYPH} data-glyph="ready">
      {DOTS.map((dot, i) => (
        <circle key={i} data-dot="" cx={dot.cx} cy={dot.cy} r="1" fill="currentColor" />
      ))}
      <circle data-core="" cx="8" cy="8" r="3.6" fill="currentColor" />
    </svg>
  );
}

/** `running`: a solid half arc leading a fading trail of dashes. */
function WorkingGlyph() {
  return (
    <svg
      {...GREEN_GLYPH}
      data-glyph="working"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      {WORKING_TRAIL.map((dash) => (
        <path key={dash.d} data-dash="" d={dash.d} opacity={dash.opacity} />
      ))}
      <path d="M8 1.7 A6.3 6.3 0 0 1 8 14.3" />
    </svg>
  );
}

const REVIEW_OVERDUE_MS = 24 * 60 * 60 * 1000;

/**
 * A review is overdue when an open change request has not moved for 24h.
 * The row then turns the review glyph from blue (your turn) to yellow (still
 * waiting on you). Merged and closed requests never count.
 */
export function isReviewOverdue(
  changeRequests: readonly { status: string; updated_at: string }[],
  now = Date.now(),
): boolean {
  return changeRequests.some(
    (cr) => cr.status === 'open' && now - Date.parse(cr.updated_at) >= REVIEW_OVERDUE_MS,
  );
}

/** A status glyph with stable 16px geometry across every session state. */
export function SessionStatusMark({
  status,
  waitingOn = 'review',
  overdue = false,
}: {
  status: SessionDisplayStatus;
  /** `needs-you` only: an agent question or permission (`answer`) or a change
   *  request (`review`). An answer blocks the agent, so callers pass it first. */
  waitingOn?: 'answer' | 'review';
  /** `needs-you` review only: it has waited too long, see `isReviewOverdue`. */
  overdue?: boolean;
}) {
  if (status === 'done') return <ReadyGlyph />;
  if (status === 'running') return <WorkingGlyph />;

  if (status === 'needs-you' && waitingOn === 'answer') {
    return (
      <QuestionIcon
        data-glyph="question"
        className="size-4 shrink-0"
        style={{ color: 'var(--kortix-blue)' }}
        aria-hidden
      />
    );
  }

  if (status === 'needs-you') {
    return (
      <GitDiffIcon
        data-glyph="review"
        className="size-4 shrink-0"
        style={{ color: overdue ? 'var(--kortix-yellow)' : 'var(--kortix-blue)' }}
        aria-hidden
      />
    );
  }

  if (status === 'legacy') {
    return (
      <ClockCounterClockwiseIcon
        className="size-3.5 shrink-0"
        style={{ color: 'var(--muted-foreground)' }}
        aria-hidden
      />
    );
  }

  const style = RING_STATUS_STYLE[status];
  return (
    <svg
      height="16"
      width="16"
      viewBox="0 0 16 16"
      style={{ color: style.color }}
      className="shrink-0"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" fill="none" strokeWidth="1.5" />
      {style.fill && <circle cx="8" cy="8" r="4" fill="currentColor" />}
    </svg>
  );
}

export type GoalStatusTone = 'green' | 'blue' | 'yellow' | 'red';

/**
 * The colour a goal session's status gives its target, by the same rule as
 * `SessionStatusMark`: green the agent acts, blue you (yellow once a review
 * waits over 24h), red broken. Nobody acting (`stopped`, `starting`,
 * `legacy`, or no status at all) leaves the target plain.
 */
export function goalStatusTone(
  status: SessionDisplayStatus | null,
  waitingOn: 'answer' | 'review' = 'review',
  overdue = false,
): GoalStatusTone | null {
  if (status === 'done' || status === 'running') return 'green';
  if (status === 'needs-you') return waitingOn === 'review' && overdue ? 'yellow' : 'blue';
  if (status === 'failed') return 'red';
  return null;
}

/**
 * `BELL_REFLECTION_MASK` (`internal/notifications/notification-bell.tsx`): the
 * colour reaches into the 16px glyph from the corner the badge sits on.
 * Copied, not imported, so this leaf module does not pull in the inbox.
 */
const GOAL_REFLECTION_MASK = 'radial-gradient(circle 12px at 100% 100%, #000 35%, transparent 100%)';

/**
 * A goal session's one leading mark: the target, tinted from its bottom-right
 * corner in the status colour with a status dot on that corner. It is the
 * notification bell's badge-glow (`BellMark`) without a number, so a goal row
 * carries one mark, not a status glyph beside a target.
 *
 * The dot's ring paints `--session-row-surface`, so it reads as cut out of
 * the row at rest, on hover and while active.
 */
export function GoalStatusMark({
  status,
  waitingOn = 'review',
  overdue = false,
}: {
  /** `null` draws the plain target (a resting goal child). */
  status: SessionDisplayStatus | null;
  waitingOn?: 'answer' | 'review';
  overdue?: boolean;
}) {
  const tone = goalStatusTone(status, waitingOn, overdue);
  const color = tone ? `var(--kortix-${tone})` : undefined;
  return (
    <span
      className="relative flex size-4 shrink-0"
      data-glyph="goal"
      data-goal-tone={tone ?? 'none'}
      aria-hidden
    >
      <TargetIcon className="text-muted-foreground size-4" />
      {color ? (
        <>
          <TargetIcon
            className="absolute inset-0 size-4"
            style={{ color, maskImage: GOAL_REFLECTION_MASK, WebkitMaskImage: GOAL_REFLECTION_MASK }}
          />
          <span className="absolute -right-0.5 -bottom-0.5 flex rounded-full bg-[var(--session-row-surface,var(--background))] p-px">
            <span data-slot="goal-status-dot" className="size-2 rounded-full" style={{ backgroundColor: color }} />
          </span>
        </>
      ) : null}
    </span>
  );
}
