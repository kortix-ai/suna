'use client';

import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { useTranslations } from '@/i18n/use-translations';

/** Pending text stays legible while the active turn continues above it. */
export const QUEUED_BUBBLE_OPACITY_CLASS =
  '[&_.text-foreground]:text-muted-foreground [&_p]:text-muted-foreground';

/** `interrupted`: the runtime holds the message but a Stop ended the turn
 *  before a step opened under it — it runs with the next send. */
export type QueuedPromptState = 'queued' | 'interrupted';

export function queuedPromptStatusLabel(state: QueuedPromptState): string {
  return state === 'interrupted' ? 'Queued — runs with your next message' : 'Queued';
}

export function QueuedPromptStatus({
  state,
  lastError,
  onRetry,
  onRemove,
}: {
  state: QueuedPromptState | 'failed';
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
}) {
  const t = useTranslations('threads');
  const copy = useTranslations('hardcodedUi.i18nComplete');
  const common = useTranslations('common');
  return (
    <InlineMeta>
      <span data-queued-status={state} className="flex items-center gap-1">
        {state === 'failed' ? (
          <>
            <span className="text-kortix-red" role="status" title={lastError ?? undefined}>
              {copy.raw('textcd5f943d5863')}
            </span>
            {onRetry && (
              <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
                {copy.raw('text942087cc2d41')}
              </Button>
            )}
            {onRemove && (
              <Button type="button" variant="ghost" size="xs" onClick={onRemove}>
                {common('remove')}
              </Button>
            )}
          </>
        ) : state === 'queued' ? (
          t('queued')
        ) : (
          queuedPromptStatusLabel(state)
        )}
      </span>
    </InlineMeta>
  );
}
