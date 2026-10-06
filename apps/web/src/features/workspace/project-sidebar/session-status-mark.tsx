'use client';

import type { SessionDisplayStatus } from '@/components/projects/session-label';
import Loading from '@/components/ui/loading';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react';

const STATUS_MARK_STYLE: Record<
  SessionDisplayStatus,
  { color: string; glyph: 'ring' | 'check'; fill: boolean }
> = {
  'needs-you': { color: 'var(--kortix-green)', glyph: 'ring', fill: true },
  starting: { color: 'var(--kortix-yellow)', glyph: 'ring', fill: false },
  running: { color: 'var(--kortix-green)', glyph: 'ring', fill: true },
  done: { color: 'var(--muted-foreground)', glyph: 'check', fill: false },
  stopped: { color: 'var(--muted-foreground)', glyph: 'ring', fill: false },
  failed: { color: 'var(--kortix-red)', glyph: 'ring', fill: true },
  legacy: { color: 'var(--muted-foreground)', glyph: 'ring', fill: false },
};

/** A status glyph with stable 16px geometry across every session state.
 *
 *  `stuck` (a starting session past the SDK's `SESSION_STARTING_STUCK_MS`)
 *  swaps the spinner for the same ring without motion: the boot has sat past
 *  every healthy bound, so the mark stops claiming progress. The words and
 *  the retry affordance live on the surfaces that carry text (the hover
 *  card, the screen-reader description).
 */
export function SessionStatusMark({
  status,
  stuck = false,
}: {
  status: SessionDisplayStatus;
  stuck?: boolean;
}) {
  const style = STATUS_MARK_STYLE[status];

  if (status === 'starting' && !stuck) {
    return <Loading className="text-kortix-yellow size-3.5" aria-hidden />;
  }

  if (status === 'legacy') {
    return (
      <ClockCounterClockwiseIcon
        className="size-3.5 shrink-0"
        style={{ color: style.color }}
        aria-hidden
      />
    );
  }

  return (
    <svg
      height="16"
      width="16"
      viewBox="0 0 16 16"
      strokeLinejoin="round"
      style={{ color: style.color }}
      className="shrink-0"
      aria-hidden
    >
      {style.glyph === 'check' ? (
        <path
          d="M4 8.4 L6.8 11.2 L12 5.2"
          stroke="currentColor"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : (
        <>
          <circle cx="8" cy="8" r="6.3" stroke="currentColor" fill="none" strokeWidth="1.5" />
          {style.fill && (
            <circle cx="8" cy="8" r={status === 'needs-you' ? 3.2 : 4} fill="currentColor" />
          )}
        </>
      )}
    </svg>
  );
}
