'use client';

import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { formatAcpDuration } from './acp-turn-grouping';

/** Shown when the harness reports no in-flight tool — the agent is between
 *  steps (streaming prose, or deciding what to do next). */
const DEFAULT_STATUS = 'Thinking';

/** 250ms strong ease-out — the exact enter curve every transcript row uses
 *  (`ENTER_TRANSITION` in `acp-chat-item-row.tsx`), so the live line arrives
 *  the same way the steps above it did. */
const ENTER_TRANSITION = { duration: 0.25, ease: [0.23, 1, 0.32, 1] as const };

/** Blur-bridged crossfade for the status label. Two different sentences
 *  hard-swapping in place reads as two objects blinking; the blur blends
 *  them into one morph. `bounce: 0` per the motion doctrine — this fires
 *  every time a tool starts, so it must never feel playful. */
const LABEL_TRANSITION = { type: 'spring', duration: 0.3, bounce: 0 } as const;

/**
 * The transcript's single live status line: pulse · what the agent is doing
 * now · how long this turn has been running.
 *
 * ## Alignment contract
 *
 * This row is the last child of the busy turn, not a banner floating at the
 * bottom of the transcript (see `acp-session-chat.tsx`), and its three
 * columns line up EXACTLY with every `AcpTranscriptStep` above it:
 *
 * ```
 * [size-4 icon box] gap-2 [label — min-w-0 flex-1 truncate] [trailing meta]
 *      ↑ pulse dot                ↑ same x as every step label   ↑ chevron column
 * ```
 *
 * The `size-4` box is what makes it work: `StepsTrigger` (`@/components/ui/steps`)
 * wraps its `leftIcon` in `size-4` and separates it from the label with
 * `gap-2`, so a bare `size-3` dot — which is what this used to render — put
 * the status text 4px to the LEFT of every tool label it follows. The dot is
 * `size-2` centred inside the same 16px box instead, which is both optically
 * correct next to 12px text and pixel-aligned with the rail.
 *
 * The elapsed timer is right-aligned into the column the steppers' chevrons
 * occupy rather than trailing the label as a `· 12s` blob, so a long tool
 * title truncates instead of pushing the timer around (and the timer's
 * `tabular-nums` keeps it from twitching as digits change).
 */
export function AcpBusyIndicator({
  statusText,
  className,
}: {
  /** The live tool title, when one is running. Falls back to "Thinking". */
  statusText?: string;
  className?: string;
}) {
  const elapsedMs = useElapsedMs();
  const reduceMotion = useReducedMotion() ?? false;
  const label = statusText?.trim() || DEFAULT_STATUS;

  return (
    <motion.div
      // `role="status"` announces the label (and only the label — the timer
      // is `aria-hidden`, or a screen reader would read a new number every
      // second for the whole turn).
      role="status"
      aria-live="polite"
      data-testid="acp-busy-indicator"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(4px)' }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0px)' }}
      transition={ENTER_TRANSITION}
      className={cn('flex w-full min-w-0 items-center gap-2 py-0.5 text-xs', className)}
    >
      <span
        className="relative inline-flex size-4 shrink-0 items-center justify-center"
        aria-hidden
      >
        {reduceMotion ? null : (
          <span className="bg-muted-foreground/30 absolute inline-flex size-2 animate-ping rounded-full" />
        )}
        <span className="bg-muted-foreground/60 relative inline-flex size-2 rounded-full" />
      </span>

      <span className="relative min-w-0 flex-1">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={label}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, filter: 'blur(0px)' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
            transition={LABEL_TRANSITION}
            className="block min-w-0"
          >
            {reduceMotion ? (
              <span className="text-muted-foreground block truncate text-xs">{label}</span>
            ) : (
              <TextShimmer className="block truncate text-xs">{label}</TextShimmer>
            )}
          </motion.span>
        </AnimatePresence>
      </span>

      <span className="text-muted-foreground/50 shrink-0 tabular-nums" aria-hidden>
        {formatAcpDuration(elapsedMs)}
      </span>
    </motion.div>
  );
}

/**
 * Milliseconds since this indicator mounted — i.e. since the turn went busy,
 * because `acp-session-chat.tsx` only mounts it while `busy`.
 *
 * Each tick recomputes from the captured `start` rather than incrementing a
 * counter, so a throttled/backgrounded tab can drop a tick without the
 * displayed elapsed time drifting behind the real one. Formatting is shared
 * with the completed-turn footer (`formatAcpDuration`), so a turn that reads
 * "1m 5s" while running still reads "1m 5s" once it lands — the old bespoke
 * `${seconds}s` counter rendered the same turn as "65s".
 */
function useElapsedMs(): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => clearInterval(timer);
  }, []);
  return elapsedMs;
}
