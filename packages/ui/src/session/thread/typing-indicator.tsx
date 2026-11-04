'use client';

import { m } from 'motion/react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';

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
export function TypingIndicator({ name, className }: { name: string; className?: string }) {
  const t = useTranslations('sessionUi.turn');
  const label = t('typing', { name });
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
    </div>
  );
}
