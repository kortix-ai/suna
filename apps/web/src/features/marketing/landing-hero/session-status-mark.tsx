'use client';

/*
 * A copy of the session status glyphs in packages/ui/src/workspace/sidebar/
 * session-status-mark.tsx on dev (3711a4ca13). This branch was cut before
 * those glyphs landed; once it merges dev, delete this file and import
 * SessionStatusMark from '@kortix/ui' instead.
 */

import { ClockCounterClockwiseIcon, GitDiffIcon, QuestionIcon } from '@phosphor-icons/react';

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

type SessionDisplayStatus = 'needs-you' | 'starting' | 'running' | 'done' | 'stopped' | 'failed' | 'legacy';

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
