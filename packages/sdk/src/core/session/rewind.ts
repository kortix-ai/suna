/**
 * Client-side projection of a staged/committed session rewind.
 *
 * `session.revert` is a STAGED pointer server-side — OpenCode never deletes
 * anything until the next prompt COMMITS it (and `unrevert` restores it while
 * staged). Nothing here talks to the network; this module is the pure math
 * the sync store and `useSession` share for two questions:
 *
 *   1. Which locally-known messages does a staged rewind hide?
 *   2. When is a message id inside the range a committed rewind must delete?
 *
 * `watermark` exists to fix a real bug: hiding used to be "everything at-or-
 * after the boundary id", recomputed on every render off the CURRENT message
 * list. A message minted AFTER staging — the user's replacement prompt, its
 * answer — sorts above the boundary by id exactly like every OTHER later
 * message, so it fell inside "everything after the boundary" too and never
 * rendered until an unrelated remount flooded the whole transcript back,
 * interleaved. `watermark` freezes the upper edge of the hide window at the
 * newest message id known AT STAGE TIME, so only messages that were already
 * part of the abandoned trajectory are ever hidden — anything newer always
 * renders.
 */

export interface SessionRewindState {
  /** The message the rewind pointer sits at — hidden along with everything
   *  up to `watermark`. */
  messageId: string;
  /**
   * The newest message id known locally at the moment this rewind was staged
   * (or first observed). The upper bound of the hide window — fixed once,
   * never recomputed against a later, larger message list.
   */
  watermark: string;
  /**
   * False once the replacement prompt has been sent (or a
   * `session.next.revert.committed` wire event says the server has). The
   * hide window still applies while this is false — what stops being offered
   * is Restore (`unrevert`), not the hiding. A committed rewind's window is
   * deleted outright once the store observes it, not merely hidden — see
   * `applyCommittedRevert` on the sync store.
   */
  staged: boolean;
}

/** Whether `id` falls inside the [messageId, watermark] hide range — both
 *  bounds inclusive: the boundary message itself is part of what an edit
 *  replaces, and the watermark is the last message known at stage time. */
export function isWithinRewindWindow(id: string, rewind: SessionRewindState): boolean {
  return id >= rewind.messageId && id <= rewind.watermark;
}

/**
 * The newest (highest sort-order) message id in `messages`, or `null` for an
 * empty list. Deliberately a max-scan, not "the last element" — most callers
 * pass an ascending-sorted list, but an optimistic entry appended out of
 * order must never win the max by position alone.
 */
export function newestMessageId<T extends { info: { id: string } }>(
  messages: T[],
): string | null {
  let max: string | null = null;
  for (const message of messages) {
    if (max === null || message.info.id > max) max = message.info.id;
  }
  return max;
}

/**
 * Build the state for a freshly staged (or freshly discovered) rewind.
 * `watermark` is captured HERE, from the message list at this exact moment —
 * never recomputed later. Falls back to `messageId` itself when nothing is
 * known locally yet (a cross-tab or reload discovery with no synced messages
 * for this session), which hides only the boundary message and nothing
 * else — the narrowest correct answer with no other information available.
 */
export function stageSessionRewind<T extends { info: { id: string } }>(
  messages: T[],
  messageId: string,
): SessionRewindState {
  return {
    messageId,
    watermark: newestMessageId(messages) ?? messageId,
    staged: true,
  };
}

/** Hide the target message and every message up to the staged watermark.
 *  Returns the SAME array reference when nothing is actually hidden — a
 *  fresh array on every call would defeat memoization in every consumer. */
export function messagesBeforeRewind<T extends { info: { id: string } }>(
  messages: T[],
  rewind: SessionRewindState | null,
): T[] {
  if (!rewind) return messages;
  const kept = messages.filter((message) => !isWithinRewindWindow(message.info.id, rewind));
  return kept.length === messages.length ? messages : kept;
}

/** Mark the rewind as committed while its removed path remains hidden
 *  locally (the actual deletion is a separate, explicit store action driven
 *  by the wire's `.committed` event — see `applyCommittedRevert`). Returns
 *  the SAME reference when already committed or when `rewind` is `null`. */
export function commitSessionRewind(
  rewind: SessionRewindState | null,
): SessionRewindState | null {
  return rewind?.staged ? { ...rewind, staged: false } : rewind;
}
