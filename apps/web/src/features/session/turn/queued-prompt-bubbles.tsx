'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { TrashIcon } from '@phosphor-icons/react';
import { nextRowActionState } from '../composer/queued-prompt-list';
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
 * Which press of a bubble's Remove runs — the Queue List's own gate
 * (`nextRowActionState`), for the same reason: the removed bubble leaves at
 * once and its neighbour slides under the pointer with its own Remove in the
 * same place, so the second click of a double-click would remove a prompt the
 * user never chose. Every bubble is its own component, so ONE gate is shared
 * by all of them rather than held in a ref.
 *
 * `focusComposer`: the bubble unmounts with its row. A keyboard press hands
 * focus to the composer instead of <body>; a pointer press does not, which
 * would raise the touch keyboard.
 */
export function createQueuedRemoveGate(): (input: {
  /** `MouseEvent.detail`. 0 means the keyboard raised the click. */
  detail: number;
  nowMs: number;
  pendingAction?: 'retry' | 'remove';
}) => { accepted: boolean; focusComposer: boolean } {
  let lastShiftAtMs: number | null = null;
  return (input) => {
    const next = nextRowActionState({ action: 'remove', ...input, lastShiftAtMs });
    lastShiftAtMs = next.lastShiftAtMs;
    return { accepted: next.accepted, focusComposer: next.accepted && input.detail === 0 };
  };
}

const queuedRemoveGate = createQueuedRemoveGate();

/** Read in event handlers only: the clock is never read while rendering. */
function pressQueuedRemove(
  event: { detail: number },
  onRemove: () => void,
  pendingAction?: 'retry' | 'remove',
): void {
  const press = queuedRemoveGate({ detail: event.detail, nowMs: Date.now(), pendingAction });
  if (!press.accepted) return;
  onRemove();
  if (press.focusComposer) window.dispatchEvent(new CustomEvent('focus-session-textarea'));
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
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={(event) => pressQueuedRemove(event, onRemove)}
          >
            {common('remove')}
          </Button>
        )}
      </span>
    </InlineMeta>
  );
}

/**
 * Remove for a Quick Queue prompt that still waits — the Queue List row's own
 * control, in the bubble's action row where Edit-from-here sits on a delivered
 * message (a waiting prompt never has both). It reveals with that row, so a
 * prompt that steers in a second never flashes a control.
 */
export function QueuedPromptRemove({
  onRemove,
  pendingAction,
}: {
  onRemove: () => void;
  /** See `QuickQueueRemove.pendingAction`. */
  pendingAction?: 'retry' | 'remove';
}) {
  const copy = useTranslations('hardcodedUi');
  const label = copy.raw('i18nComplete.textc0b9d9e9ac1d');
  return (
    <Hint label={label} side="top" align="center">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="hit-area-2"
        aria-label={label}
        // `aria-disabled`, never `disabled`: disabling the pressed button drops
        // focus to <body>. It does not block a click — the gate does.
        aria-disabled={pendingAction ? true : undefined}
        onClick={(event) => pressQueuedRemove(event, onRemove, pendingAction)}
      >
        {pendingAction === 'remove' ? (
          <Loading className="size-3.5 shrink-0" />
        ) : (
          <TrashIcon className="size-4" />
        )}
      </Button>
    </Hint>
  );
}
