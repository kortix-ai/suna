'use client';

import { m } from 'motion/react';
import { useEffect, useState } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';

/** The clock of a wait since `sinceIso` ("0:42"), ticking each second; null without a start. */
export function useElapsedLabel(sinceIso: string | null | undefined, format: (ms: number) => string): string | null {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Number.isNaN(since)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return Number.isNaN(since) ? null : format(Math.max(0, now - since));
}

/** One dot's cycle; the next dot starts a third of it later. */
const DOT_CYCLE_S = 1.2;
const DOTS = [0, 1, 2] as const;

/**
 * The agent's busy line in a messages-only thread (`TranscriptRows.messagesOnly`):
 * three dots that pulse one after another under the agent's name, the way a
 * person's chat reads; "Kortix is typing…" is only its accessible label. It never names a tool or a step. Opacity only, so the
 * reduced-motion variant is the same animation (`kortix-brand` motion.md).
 * The offset between dots is a loader's wave, not an entrance stagger: it
 * delays no content, and the three dots read as one moving thing.
 */
export function TypingIndicator({
  name,
  className,
  detail,
  detailDelayMs = 0,
}: {
  name: string;
  className?: string;
  /**
   * A quiet status after the dots ("Starting…", "Working · 0:42"): what the
   * wait is, so a long one never reads as frozen. Shown after `detailDelayMs`
   * (a short wait stays three dots).
   */
  detail?: string | null;
  detailDelayMs?: number;
}) {
  const t = useTranslations('sessionUi.turn');
  const label = t('typing', { name });
  const [late, setLate] = useState(detailDelayMs <= 0);
  useEffect(() => {
    if (detailDelayMs <= 0) return;
    const timer = setTimeout(() => setLate(true), detailDelayMs);
    return () => clearTimeout(timer);
  }, [detailDelayMs]);
  const shownDetail = detail && late ? detail : null;
  return (
    // Three dots under the name the row already shows: the label is for screen readers only.
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid="typing-indicator"
      className={cn('flex h-6 items-center', className)}
    >
      <span aria-hidden className="flex items-center gap-1">
        {DOTS.map((dot) => (
          <m.span
            key={dot}
            className="bg-muted-foreground size-1 rounded-full"
            initial={{ opacity: 0.3 }}
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: DOT_CYCLE_S, repeat: Infinity, ease: 'easeInOut', delay: (dot * DOT_CYCLE_S) / 3 }}
          />
        ))}
      </span>
      {shownDetail ? (
        // Plain text, no motion: it changes once a second while the clock runs.
        <span className="text-muted-foreground ml-2 text-xs tabular-nums">{shownDetail}</span>
      ) : null}
    </div>
  );
}
