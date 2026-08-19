/**
 * Undo for "Removed from queue", against the server inbox.
 *
 * The queue row used to live in a browser store, so Undo rebuilt it from a
 * hand-written field list and put it back at its old index. Every field the
 * queue grew after that list was written got dropped — `command`, then `files`
 * — and each drop was silent, under a button labelled "Undo".
 *
 * The row is a server row now and `DELETE .../prompts/:id` hands back exactly
 * what it destroyed. That response is the only lossless source: the row is
 * HARD-deleted, and the list view carries only a 2000-char text preview with no
 * parts at all, so restoring from the list would drop every attachment and the
 * agent/model/variant picks. So this function names nothing — it re-POSTs what
 * came back.
 *
 * There is no index to restore. Position in the inbox is `created_at`, and the
 * server decides delivery order from it; an undone row goes to the back, which
 * is where a message re-queued a moment later belongs. Its wire message id is
 * re-minted for the same reason — see `restoreQueuedMessage`.
 */

import type { CreateSessionPromptInput, RemovedSessionPrompt } from '@kortix/sdk';

/**
 * The re-POST body for a removed prompt: the original CONTENT, a fresh wire id.
 *
 * `clientMessageId` is the original, so the inbox's unique idempotency key
 * makes a repeated undo a no-op rather than a second copy of the message.
 *
 * `messageId` is NOT. OpenCode resolves "has this prompt been answered?" by id
 * ORDER, and the original id was minted when the row was first queued — before
 * a turn that has been writing higher ids ever since. (Stop, remove, undo is
 * the ordinary way this happens: by then the aborted turn has written its
 * assistant messages.) Re-sending under that id makes OpenCode read the prompt
 * as already answered: the row is marked succeeded, drops out of
 * `GET /prompts`, and never runs — under a button labelled "Undo" that
 * reported success. A re-queued prompt belongs at the END of the transcript,
 * which is where a fresh mint puts it, and which is where `handleSend` puts
 * every other message.
 */
export function restoreQueuedMessage(
  removed: RemovedSessionPrompt,
  mintMessageId: () => string,
): CreateSessionPromptInput {
  return {
    clientMessageId: removed.client_message_id,
    messageId: mintMessageId(),
    parts: removed.parts,
    ...(removed.overrides ? { overrides: removed.overrides } : {}),
  };
}

/**
 * The Undo action for ONE removed prompt. Runs at most once.
 *
 * The latch is belt-and-braces beside the server's unique index — a second POST
 * would be deduped, not duplicated — but it is what stops the second request
 * being issued at all. `infoToast` renders `options.button` verbatim
 * (`components/ui/toast.tsx`), so the button stays on screen for the full 5s
 * after it is pressed, and the dismiss animation is not instant.
 */
export function createQueueUndoAction(args: {
  removed: RemovedSessionPrompt;
  /** A wire message id minted NOW, against the live transcript — see
   *  `restoreQueuedMessage`. */
  mintMessageId: () => string;
  enqueue: (input: CreateSessionPromptInput) => Promise<unknown>;
  /** Close the toast that hosts this button. */
  dismiss?: () => void;
  onError?: (cause: unknown) => void;
}): () => void {
  let used = false;
  return () => {
    if (used) return;
    used = true;
    args.dismiss?.();
    void args
      .enqueue(restoreQueuedMessage(args.removed, args.mintMessageId))
      .catch((cause) => args.onError?.(cause));
  };
}
