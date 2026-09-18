/**
 * What a queue row action SAYS, and the one handler that says it.
 *
 * Every surface that removes, retries, restores or resumes a queued prompt
 * used to write its own toast policy. Two of them toasted the server's prose
 * (`errorToast(error.message)`), so a refused removal painted a bare "Not
 * found" — English, untranslated, and meaningless next to the "Removed from
 * queue" toast a second DELETE had already painted. One intent must give one
 * outcome and at most one sentence.
 *
 * The SDK classifies the refusal (`classifyPromptActionError`, which reads
 * `status` and `code` and never `message`). This module maps that
 * classification to a copy key, or to `null` where the refusal IS the outcome
 * the user asked for and there is nothing to report.
 */

import { Button } from '@/components/ui/button';
import { dismissToast, errorToast, infoToast } from '@/components/ui/toast';
import type { CreateSessionPromptInput, RemovedSessionPrompt } from '@kortix/sdk';
import { classifyPromptActionError } from '@kortix/sdk/react';
import { createElement } from 'react';
import { createQueueUndoAction } from './queued-message-restore';

/** The SDK's verdict on a refused row action. */
export type PromptActionFailure = ReturnType<typeof classifyPromptActionError>;

/** The one refusal the transport hands back WITHOUT reporting it: a request
 *  that ran past the server's processing deadline (`api-client.ts`). Its three
 *  siblings there — `feature_not_supported`, `model_not_servable`,
 *  `provision_in_flight` — belong to routes a prompt send never reaches. */
const UNREPORTED_REFUSAL_CODE = 'request_deadline';

/**
 * Does a refused SEND still need the caller's own sentence?
 *
 * `createSessionPrompt` keeps the transport's error sink on for a send — that
 * is what opens the upgrade dialog on a 402 — so a caller that adds a sentence
 * of its own says one refusal twice. It speaks only where the sink stayed
 * quiet: a failure that never reached the server, and the one code the
 * transport reports to the caller alone.
 */
export function sendRefusalNeedsOwnToast(error: unknown): boolean {
  const refusal = (error ?? null) as { status?: unknown; code?: unknown } | null;
  if (typeof refusal?.status !== 'number') return true;
  return refusal.code === UNREPORTED_REFUSAL_CODE;
}

/** "Removed from queue". */
export const QUEUE_REMOVED_KEY = 'i18nComplete.text2c6041fda32c';
/** The Undo button on that toast. */
export const QUEUE_UNDO_KEY = 'i18nComplete.texta737e54996f8';
/** "Could not resume the queue" — the Resume control's only failure. */
export const QUEUE_RESUME_FAILED_KEY = 'i18nComplete.text06619384104c';
/** "Try again in a moment." — what to do about it. */
export const QUEUE_RESUME_FAILED_DESCRIPTION_KEY = 'i18nComplete.text29cc3339fce9';
/** How long the "Removed from queue" toast, and its Undo, stay on screen. */
export const QUEUE_REMOVED_TOAST_MS = 5000;

const REMOVE_FAILURE_KEYS: Record<PromptActionFailure, string | null> = {
  // Another tab removed it, or it never existed. The row is gone either way,
  // which is what the click asked for, but the user did not cause it.
  gone: 'i18nComplete.text128773c76940',
  already_sent: 'i18nComplete.text3e739b3b4329',
  unreachable: 'i18nComplete.text42fcd9dda5f6',
  failed: 'i18nComplete.text42fcd9dda5f6',
  // The row's other action is still running and no request was sent. The user
  // pressed twice; the first press is still the outcome.
  pending: null,
};

const RETRY_FAILURE_KEYS: Record<PromptActionFailure, string | null> = {
  // The row left the list. Retry meant "send this"; it is not there to send,
  // and the list already shows that.
  gone: null,
  // The drain is sending it. That IS retry's outcome.
  already_sent: null,
  pending: null,
  unreachable: 'i18nComplete.text4869b2a820dd',
  failed: 'i18nComplete.text4869b2a820dd',
};

/** The copy key for a refused Remove, or `null` for nothing to say. */
export function removeFailureCopyKey(failure: PromptActionFailure): string | null {
  return REMOVE_FAILURE_KEYS[failure];
}

/** The copy key for a refused Retry, or `null` for nothing to say. */
export function retryFailureCopyKey(failure: PromptActionFailure): string | null {
  return RETRY_FAILURE_KEYS[failure];
}

/**
 * The copy key for a refused Undo, or `null`.
 *
 * A restore POST asks the SDK to keep its refusals off the host error sink
 * (`createSessionPrompt`, `showErrors: false`) except for `402`, which it
 * routes to the sink so the upgrade dialog opens. So a 402 is already answered
 * on screen: a second sentence here would be the two-toast bug again.
 */
export function restoreFailureCopyKey(cause: unknown): string | null {
  const status = (cause as { status?: unknown } | null)?.status;
  if (status === 402) return null;
  return 'i18nComplete.text8af21acebf14';
}

/**
 * Say that the queue is still paused.
 *
 * One function rather than two call sites: the chat painted title +
 * description and the boot shell painted the title alone, so the same failure
 * read differently depending on whether the sandbox had finished starting.
 * The hold is shared by every tab, so the user has to know it is still on.
 */
export function queueResumeFailedToast(copy: (key: string) => string): void {
  errorToast(copy(QUEUE_RESUME_FAILED_KEY), {
    description: copy(QUEUE_RESUME_FAILED_DESCRIPTION_KEY),
  });
}

export interface QueueRemoveHandlerDeps {
  sessionId: string;
  /** `useTranslations('hardcodedUi').raw`. */
  copy: (key: string) => string;
  remove: (promptId: string) => Promise<RemovedSessionPrompt>;
  enqueue: (input: CreateSessionPromptInput) => Promise<unknown>;
  /** A wire message id minted NOW — see `restoreQueuedMessage`. */
  mintMessageId: () => string;
  /** Drop every other copy of the removed message, before the toast paints. */
  onRemoved?: (removed: RemovedSessionPrompt) => void;
}

/**
 * Remove one queued prompt and report the single outcome.
 *
 * Both hosts call this. The boot shell used to remove silently — no toast, no
 * Undo — so the same button did two different things depending on whether the
 * sandbox had finished starting.
 *
 * Undo rather than a confirm dialog: a queue is something you curate, and
 * gating every removal behind a modal would make it unusable. The DELETE hands
 * back exactly what it destroyed, which is the only lossless undo — the row is
 * hard-deleted and the list view carries a text preview with no parts at all.
 *
 * The toast id is the removed row's, so a repeat of the SAME removal replaces
 * its toast instead of stacking a second one.
 */
export function createQueueRemoveHandler(
  deps: QueueRemoveHandlerDeps,
): (promptId: string) => Promise<void> {
  return async (promptId: string) => {
    let removed: RemovedSessionPrompt;
    try {
      removed = await deps.remove(promptId);
    } catch (error) {
      const key = removeFailureCopyKey(classifyPromptActionError(error));
      if (key) errorToast(deps.copy(key));
      return;
    }
    if (!removed) return;
    deps.onRemoved?.(removed);

    const undoToastId = `queue-undo-${deps.sessionId}-${removed.prompt_id}`;
    infoToast(deps.copy(QUEUE_REMOVED_KEY), {
      id: undoToastId,
      duration: QUEUE_REMOVED_TOAST_MS,
      // The SAME `clientMessageId`, so an undo re-creates ONE row and a
      // double-click cannot create two. A FRESH wire id, because OpenCode
      // orders by id and the original was minted before the turn that has been
      // writing higher ids since. The parts and overrides are the ORIGINALS,
      // straight from the delete's own response — see `createQueueUndoAction`.
      button: createElement(
        Button,
        {
          size: 'sm',
          variant: 'outline',
          onClick: createQueueUndoAction({
            removed,
            mintMessageId: deps.mintMessageId,
            enqueue: deps.enqueue,
            dismiss: () => dismissToast(undoToastId),
            onError: (cause) => {
              const key = restoreFailureCopyKey(cause);
              if (key) errorToast(deps.copy(key));
            },
          }),
        },
        deps.copy(QUEUE_UNDO_KEY),
      ),
    });
  };
}
