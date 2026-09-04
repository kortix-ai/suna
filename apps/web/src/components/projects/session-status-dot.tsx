'use client';

import {
  SESSION_DISPLAY_STATUS_LABELS,
  type SessionDisplayStatus,
  sessionDisplayStatus,
} from '@/components/projects/session-label';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import type { ProjectSession } from '@kortix/sdk';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react';

/** Per-display-status paint. Green appears in exactly two rows — the two that
 *  mean live or actionable. `done` is muted on purpose: it is the change that
 *  drains the green out of a long list and makes the rest mean something.
 *
 *  `glyph` is what separates the two muted states. Both used to be rings that
 *  differed only by a dash pattern, and at 16px that is not a difference a user
 *  can see. Per spec §4 `done` is a check and `stopped` is a plain hollow ring.
 *  The check stays muted — a check is not a licence to go green. */
export const STATUS_DOT_STYLE: Record<
  SessionDisplayStatus,
  { color: string; glyph: 'ring' | 'check'; fill: boolean }
> = {
  'needs-you': { color: 'var(--kortix-green)', glyph: 'ring', fill: true },
  // `starting` renders <Loading /> instead and never reads glyph/fill.
  starting: { color: 'var(--kortix-yellow)', glyph: 'ring', fill: false },
  running: { color: 'var(--kortix-green)', glyph: 'ring', fill: true },
  done: { color: 'var(--muted-foreground)', glyph: 'check', fill: false },
  stopped: { color: 'var(--muted-foreground)', glyph: 'ring', fill: false },
  failed: { color: 'var(--kortix-red)', glyph: 'ring', fill: true },
  // `legacy` renders <ClockCounterClockwiseIcon /> instead and never reads
  // glyph/fill — a dormant migrated chat is neither done nor merely stopped;
  // the history glyph says "restorable" without spending any color.
  legacy: { color: 'var(--muted-foreground)', glyph: 'ring', fill: false },
};

/**
 * The 16px status glyph on its own — ring / filled ring / check / spinner /
 * history — for any surface that paints a session's display status: the
 * sidebar row (via `SessionStatusDot`), the Monitoring run strip, its legend.
 * One drawing, so the dot means the same thing everywhere it appears.
 */
export function StatusGlyph({
  display,
  className,
}: {
  display: SessionDisplayStatus;
  className?: string;
}) {
  const style = STATUS_DOT_STYLE[display];
  if (display === 'starting') {
    // Loading is the only spinner in this codebase. The previous
    // implementation spun an SVG with animate-spin, which the rule bans.
    return <Loading className={cn('text-kortix-yellow size-3.5', className)} />;
  }
  if (display === 'legacy') {
    return (
      <ClockCounterClockwiseIcon
        className={cn('size-3.5 shrink-0', className)}
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
      className={cn('flex shrink-0 items-center justify-center', className)}
      aria-hidden
    >
      {style.glyph === 'check' ? (
        // Same 16px box, same 1.5 stroke, same currentColor as the rings,
        // so the dot column stays optically aligned row to row.
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
            <circle cx="8" cy="8" r={display === 'needs-you' ? 3.2 : 4} fill="currentColor" />
          )}
        </>
      )}
    </svg>
  );
}

export function SessionStatusDot({
  session,
  reviewCount = 0,
}: {
  session: ProjectSession;
  reviewCount?: number;
}) {
  const display = sessionDisplayStatus(session, reviewCount);
  const label =
    display === 'needs-you'
      ? `${reviewCount} awaiting your review`
      : SESSION_DISPLAY_STATUS_LABELS[display];

  return (
    <Hint side="right" label={<span className="text-xs">{label}</span>}>
      <div className="flex size-4 shrink-0 items-center justify-center">
        <StatusGlyph display={display} />
      </div>
    </Hint>
  );
}
