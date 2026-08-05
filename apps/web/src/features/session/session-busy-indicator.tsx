'use client';

import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

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
  retryLabel,
  ambient = false,
  className,
}: {
  statusText?: string;
  retryLabel?: string;
  ambient?: boolean;
  className?: string;
}): React.ReactElement {
  const reduceMotion = useReducedMotion() ?? false;
  const hasMounted = useRef(false);
  const retryText = retryLabel?.trim();
  const isRetrying = Boolean(retryText);
  const status = statusText?.trim();

  useEffect(() => {
    hasMounted.current = true;
  }, []);

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
      aria-live="polite"
      data-testid="session-busy-indicator"
      className={cn(
        'text-muted-foreground flex w-full min-w-0 items-center gap-1.5 py-0.5 text-xs',
        className,
      )}
    >
      <span className="relative min-w-0 flex-1" aria-hidden>
        {isRetrying ? (
          <span className="text-muted-foreground/70 block truncate text-sm leading-5">{label}</span>
        ) : (
          <span className="relative block min-w-0 overflow-hidden leading-5">
            <AnimatePresence mode="popLayout">
              <m.span
                key={label}
                initial={hasMounted.current ? swap.initial : swap.animate}
                animate={swap.animate}
                exit={swap.exit}
                transition={swap.transition}
                className="block min-w-0 whitespace-nowrap will-change-transform"
              >
                <TextShimmer className="truncate text-sm leading-5">{label}</TextShimmer>
              </m.span>
            </AnimatePresence>
          </span>
        )}
      </span>
      <span className="sr-only">{label}</span>
    </m.div>
  );
}
