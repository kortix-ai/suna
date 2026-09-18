'use client';

import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { useTranslations } from '@/i18n/use-translations';
import { isRetryableFailure, queueFailureLine } from '../queue-failure-copy';

/** Pending text stays legible while the active turn continues above it. */
export const QUEUED_BUBBLE_OPACITY_CLASS =
  '[&_.text-foreground]:text-muted-foreground [&_p]:text-muted-foreground';

/** `interrupted`: the runtime holds the message but a Stop ended the turn
 *  before a step opened under it — it runs with the next send. */
export type QueuedPromptState = 'queued' | 'interrupted';

export type QueuedPromptStatusState = QueuedPromptState | 'failed' | 'sending' | 'held';

/** Ring tone for a queued bubble. `pending` covers waiting and sending, so a
 *  delivery retry that flips a row between them never changes the ring. */
export type QueuedBubbleTone = 'pending' | 'held' | 'failed';

export function queuedBubbleTone(
  state: QueuedPromptStatusState | null | undefined,
): QueuedBubbleTone | undefined {
  if (!state) return undefined;
  if (state === 'failed' || state === 'held') return state;
  return 'pending';
}

/**
 * The only status text a queued user message renders: a delivery failure and
 * its recovery actions. Waiting, sending, paused, and interrupted prompts show
 * no words — muted text marks them, and the queue list above the composer
 * names how many wait and whether the queue is paused.
 */
export function QueuedPromptFailure({
  lastError,
  failureCode,
  onRetry,
  onRemove,
}: {
  lastError?: string | null;
  /** The server's stable cause. The same sentence map the Queue List uses, so
   *  Quick Queue and Queue List cannot describe one failure two ways. */
  failureCode?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
}) {
  const copy = useTranslations('hardcodedUi');
  const common = useTranslations('common');
  const failure = queueFailureLine({ failureCode, lastError, copy: (key) => copy.raw(key) });
  // A session that no longer exists refuses every retry, so the bubble offers
  // only Remove — the same rule the Queue List row follows.
  const canRetry = isRetryableFailure(failureCode);
  return (
    <InlineMeta>
      <span data-queued-status="failed" className="flex items-center gap-1">
        <span className="text-kortix-red" role="status" title={failure.title}>
          {failure.text}
        </span>
        {onRetry && canRetry && (
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            {copy.raw('i18nComplete.text942087cc2d41')}
          </Button>
        )}
        {onRemove && (
          <Button type="button" variant="ghost" size="xs" onClick={onRemove}>
            {common('remove')}
          </Button>
        )}
      </span>
    </InlineMeta>
  );
}
