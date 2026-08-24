'use client';

import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';

const DEFAULT_STATUS = 'Thinking';

const AMBIENT_MESSAGES = [
  'Reading the context',
  'Working through the problem',
  'Tracing the logic',
  'Checking the details',
  'Weighing the options',
  'Pulling it together',
  'Verifying the approach',
  'Mapping the next step',
  'Drafting the response',
  'Polishing the answer',
] as const;

const AMBIENT_HOLD_MS = 4000;

const ROLL_SWAP = {
  initial: { transform: 'translateY(100%)', opacity: 0 },
  animate: { transform: 'translateY(0%)', opacity: 1 },
  exit: { transform: 'translateY(-100%)', opacity: 0 },
  transition: { type: 'spring', duration: 0.4, bounce: 0 },
} as const;

const FADE_SWAP = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

export function SessionBusyIndicator({
  statusText,
  elapsedLabel,
  retryLabel,
  ambient = false,
  sessionId,
  className,
}: {
  statusText?: string;
  /**
   * Live elapsed time for the current status, e.g. `"24s"`. Rendered beside the
   * phrase in its OWN non-animated span: it ticks once a second, and folding it
   * into `statusText` would change the `AnimatePresence` key every second and
   * replay the roll-swap forever during long tool calls.
   */
  elapsedLabel?: string;
  retryLabel?: string;
  ambient?: boolean;
  /**
   * Keys the dot-matrix glyph: each session hashes to its own variant
   * (`SessionDotMatrix`), stable for that session's whole life. Session-less
   * surfaces (home demo, debug harness) omit it and keep the default glyph.
   */
  sessionId?: string;
  className?: string;
}): React.ReactElement {
  const reduceMotion = useReducedMotion() ?? false;
  const retryText = retryLabel?.trim();
  const isRetrying = Boolean(retryText);
  const status = statusText?.trim();
  const elapsed = elapsedLabel?.trim();

  const [ambientIdx, setAmbientIdx] = useState(() =>
    Math.floor(Math.random() * AMBIENT_MESSAGES.length),
  );

  const useAmbient = ambient && !isRetrying && !status;
  useEffect(() => {
    if (!useAmbient) return;
    const id = setInterval(() => {
      setAmbientIdx((i) => (i + 1) % AMBIENT_MESSAGES.length);
    }, AMBIENT_HOLD_MS);
    return () => clearInterval(id);
  }, [useAmbient]);

  const label =
    retryText ||
    status ||
    (useAmbient ? AMBIENT_MESSAGES[ambientIdx % AMBIENT_MESSAGES.length] : DEFAULT_STATUS);
  const swap = reduceMotion ? FADE_SWAP : ROLL_SWAP;

  return (
    <m.div
      role="status"
      // `role="status"` implies aria-live="polite". The ambient filler rotates
      // on a 4s timer and carries no information, so it is muted — otherwise a
      // screen reader re-reads a new phrase every 4 seconds for the whole turn.
      // A real status or retry label still announces.
      aria-live={useAmbient ? 'off' : 'polite'}
      data-testid="session-busy-indicator"
      className={cn(
        'text-muted-foreground flex w-full min-w-0 items-center gap-1.5 py-0.5 text-xs',
        className,
      )}
    >
      <SessionDotMatrix sessionId={sessionId} size={14} className="shrink-0" />
      <span className="relative min-w-0 flex-1" aria-hidden>
        {isRetrying ? (
          <span className="text-muted-foreground/70 block truncate text-sm leading-5 tabular-nums">
            {label}
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="relative block min-w-0 flex-1 overflow-hidden leading-5">
              <AnimatePresence initial={false} mode="popLayout">
                <m.span
                  key={label}
                  initial={swap.initial}
                  animate={swap.animate}
                  exit={swap.exit}
                  transition={swap.transition}
                  className="block min-w-0 whitespace-nowrap"
                >
                  <TextShimmer className="truncate text-center align-middle text-sm leading-5">
                    {label}
                  </TextShimmer>
                </m.span>
              </AnimatePresence>
            </span>
            {elapsed ? (
              <span className="text-muted-foreground/70 shrink-0 text-sm leading-5 tabular-nums">
                {elapsed}
              </span>
            ) : null}
          </span>
        )}
      </span>
      <span className="sr-only">{label}</span>
    </m.div>
  );
}
