'use client';

import {
  SESSION_DISPLAY_STATUS_LABELS,
  type SessionDisplayStatus,
} from '@/components/projects/session-label';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/** Per-display-status paint. Green appears in exactly two rows — the two that
 *  mean live or actionable. `done` is muted on purpose: it is the change that
 *  drains the green out of a long list and makes the rest mean something.
 *
 *  `glyph` is what separates the two muted states. Both used to be rings that
 *  differed only by a dash pattern, and at 16px that is not a difference a user
 *  can see. Per spec §4 `done` is a check and `stopped` is a plain hollow ring.
 *  The check stays muted — a check is not a licence to go green. */
const STATUS_DOT_STYLE: Record<
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
 * The 16px session status circle. ONE implementation for every surface that
 * paints a session's state — the project sidebar's session rows and the craft
 * run strips on the craft-report surfaces. It lived inside
 * `project-session-list.tsx` until the craft reports needed the same glyph;
 * two copies of this paint table is exactly how a `done` check ends up green
 * on one screen and muted on another.
 *
 * It takes a resolved `SessionDisplayStatus`, not a `ProjectSession`, so a
 * surface with no session payload (a craft run summary) renders the identical
 * dot. Callers holding a session resolve it with `sessionDisplayStatus`.
 */
export function SessionStatusDot({
  status,
  label,
  hintSide = 'right',
  hint = true,
  className,
}: {
  status: SessionDisplayStatus;
  /** Overrides the default status label in the tooltip (e.g. a review count,
   *  or a run's status + time + summary). */
  label?: ReactNode;
  hintSide?: 'top' | 'right' | 'bottom' | 'left';
  /** Set false where the glyph already sits beside its own written label — a
   *  legend key. A tooltip repeating the visible text is noise, and it makes
   *  a non-interactive key look interactive. */
  hint?: boolean;
  className?: string;
}) {
  const style = STATUS_DOT_STYLE[status];

  const glyph = (
    <div className={cn('flex size-4 shrink-0 items-center justify-center', className)}>
      {status === 'starting' ? (
        // Loading is the only spinner in this codebase. The previous
        // implementation spun an SVG with animate-spin, which the rule bans.
        <Loading className="text-kortix-yellow size-3.5" />
      ) : status === 'legacy' ? (
        <ClockCounterClockwiseIcon
          className="size-3.5 shrink-0"
          style={{ color: style.color }}
          aria-hidden
        />
      ) : (
        <svg
          height="16"
          width="16"
          viewBox="0 0 16 16"
          strokeLinejoin="round"
          style={{ color: style.color }}
          className="flex shrink-0 items-center justify-center"
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
                <circle cx="8" cy="8" r={status === 'needs-you' ? 3.2 : 4} fill="currentColor" />
              )}
            </>
          )}
        </svg>
      )}
    </div>
  );

  if (!hint) return glyph;
  return (
    <Hint
      side={hintSide}
      label={label ?? <span className="text-xs">{SESSION_DISPLAY_STATUS_LABELS[status]}</span>}
    >
      {glyph}
    </Hint>
  );
}
