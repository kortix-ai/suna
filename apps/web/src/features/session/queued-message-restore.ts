/**
 * Turn a queued message that was just removed back into something enqueueable.
 *
 * This exists because the Undo button on "Removed from queue" used to rebuild
 * the entry from a hand-written field list — `text`, `mentions`, `agent`,
 * `model`, `variant` — written before the queue could hold anything else. When
 * the queue grew `command` (27279d2232), Undo kept dropping it: removing a
 * queued `/webapp` and pressing Undo returned a plain text message, and if that
 * command had no arguments its `text` is `''`, so the restored entry dispatched
 * an empty prompt. `files` had been dropped by the same list since the day it
 * was written.
 *
 * So this function names what it DROPS, never what it keeps. That inversion is
 * the entire point: a field added to the queue tomorrow is carried by default,
 * and only a deliberate edit here can stop carrying it. A keep-list is a
 * standing invitation to forget.
 *
 * What is dropped is the queue's own bookkeeping, and each for a reason:
 *
 *   - `id` / `clientMessageId` — minted by the store. The restored entry is a
 *     new entry; the old ids belong to a message that was removed.
 *   - `createdAt` — it is being queued now.
 *   - `attempts` / `lastError` — a restored entry has not been tried yet, and
 *     must not carry the error of a send that never happened. (Undo is offered
 *     for failed entries too, not only pending ones.)
 *
 * Position is not this function's business: `handleRemoveQueuedMessage` puts
 * the entry back at the index it came from, since enqueue always appends.
 */

import { useMessageQueueStore } from '@/stores/message-queue-store';
import type { EnqueueInput, WebQueuedMessage } from '@/stores/message-queue-store';

export function restoreQueuedMessage(removed: WebQueuedMessage): EnqueueInput {
  const {
    id: _id,
    clientMessageId: _clientMessageId,
    createdAt: _createdAt,
    attempts: _attempts,
    lastError: _lastError,
    ...carried
  } = removed;
  return carried;
}

/**
 * The Undo action for ONE removed queue entry. Restores it at the position it
 * came from, then refuses to run again.
 *
 * Running at most once is the whole reason this is a function rather than an
 * inline handler. `infoToast` renders `options.button` verbatim
 * (`components/ui/toast.tsx`) and the sonner id needed to dismiss the toast is
 * only in scope inside the toast's own render callback — so the button stays on
 * screen for the full 5s after it is pressed. A second press re-ran the restore
 * and the entry came back TWICE: two prompts, or since 27279d2232 two runs of
 * the same `/command`. Dismissing on the first press is the visible half of the
 * fix; the latch is the half that actually holds, because the dismiss animation
 * is not instant and a double-click beats it.
 *
 * `index` is where the entry sat in `pending`, i.e. `-1` when it was removed
 * from `failed`. Negative means "no position to restore" — append — because
 * reordering to a negative index clamps to the head and jumps the queue.
 */
export function createQueueUndoAction(args: {
  sessionId: string;
  removed: WebQueuedMessage;
  /** Its old index in `pending`, or -1 when it came from `failed`. */
  index: number;
  /** Close the toast that hosts this button. */
  dismiss?: () => void;
}): () => void {
  let used = false;
  return () => {
    if (used) return;
    used = true;
    args.dismiss?.();
    const store = useMessageQueueStore.getState();
    store.enqueue(args.sessionId, restoreQueuedMessage(args.removed));
    if (args.index < 0) return;
    // `enqueue` always appends, so the entry is the tail until it is moved.
    const pending = store.getSessionQueue(args.sessionId).pending;
    const last = pending[pending.length - 1];
    if (last) store.reorder(args.sessionId, last.id, args.index);
  };
}
