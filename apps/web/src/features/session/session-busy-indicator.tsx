'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';

/** Shown when the session reports no in-flight tool — the agent is between
 *  steps (streaming prose, or deciding what to do next). */
const DEFAULT_STATUS = 'Thinking';

/** 250ms strong ease-out — the enter curve UI motion in this app uses. */
const ENTER_TRANSITION = { duration: 0.25, ease: [0.23, 1, 0.32, 1] as const };

/** Blur-bridged crossfade for the status label. Two different sentences
 *  hard-swapping in place read as two objects blinking; the blur blends them
 *  into one morph. `bounce: 0` because this fires every time a tool starts, so
 *  it must never feel playful. */
const LABEL_TRANSITION = { type: 'spring', duration: 0.3, bounce: 0 } as const;

export function SessionBusyIndicator({
  statusText,
  retryLabel,
  elapsed,
  className,
}: {
  /** The live tool status, when the session reports one. Falls back to "Thinking". */
  statusText?: string;
  /** Set while the session is waiting to retry. Wins over `statusText` and
   *  suppresses the shimmer — waiting is not working. */
  retryLabel?: string;
  /** Pre-formatted elapsed time, ticked by the parent from the turn's own
   *  start timestamp. Passed in rather than measured here so it survives a
   *  remount and reports the turn, not this component's lifetime. */
  elapsed?: string;
  className?: string;
}): React.ReactElement {
  const reduceMotion = useReducedMotion() ?? false;
  const retryText = retryLabel?.trim();
  const isRetrying = Boolean(retryText);
  const label = retryText || statusText?.trim() || DEFAULT_STATUS;

  return (
    <motion.div
      role="status"
      aria-live="polite"
      data-testid="session-busy-indicator"
      transition={ENTER_TRANSITION}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(4px)' }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0px)' }}
      className={cn(
        'text-muted-foreground flex w-full min-w-0 items-center gap-1.5 py-0.5 text-xs',
        className,
      )}
    >
      {/* This slot carries the alignment contract: every tool row (TOOL_ROW_CLASS in
          tool/shared/infrastructure.tsx) is `flex items-center gap-1.5` with a size-3.5
          leading icon, which puts every tool label at 20px from the row's left edge. A
          14px slot plus gap-1.5 lands this label on that same 20px. The dot is size-2,
          centred inside it, which is optically correct next to 12px text. */}
      <span
        className="relative inline-flex size-3.5 shrink-0 items-center justify-center"
        aria-hidden
      >
        {/* motion-reduce, not the JS `reduceMotion` flag: useReducedMotion() reads
            false on the server and true on a reduced-motion client, so gating the
            node on it would mismatch hydration. */}
        <span className="bg-muted-foreground/30 absolute inline-flex size-2 animate-ping rounded-full motion-reduce:animate-none" />
        <span className="bg-muted-foreground/50 relative inline-flex size-2 rounded-full" />
      </span>
      {/* The visual label is hidden from assistive tech and mirrored by the sr-only
          span below: `popLayout` keeps the exiting node mounted for the full 300ms
          exit, so for that window the live region would hold both the old and the
          new label and announce the pair. */}
      <span className="relative min-w-0 flex-1" aria-hidden>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={label}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, filter: 'blur(0px)' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
            transition={LABEL_TRANSITION}
            className="block min-w-0"
          >
            {reduceMotion || isRetrying ? (
              <span className="text-muted-foreground/70 block truncate text-xs">{label}</span>
            ) : (
              <TextShimmer className="block truncate text-xs">{label}</TextShimmer>
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="sr-only">{label}</span>
      {elapsed && (
        // aria-hidden: role="status" would otherwise make a screen reader announce a
        // new number every second for the whole turn.
        // Right-aligned in its own column: a long tool title truncates instead of
        // pushing the timer around.
        <span className="text-muted-foreground/50 shrink-0 tabular-nums" aria-hidden>
          {elapsed}
        </span>
      )}
    </motion.div>
  );
}
