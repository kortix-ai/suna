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
 * The window is a SET of message ids, captured at stage time. It used to be a
 * lexical id RANGE — `id >= messageId && id <= watermark` — which assumed ids
 * ascend with time. OpenCode 1.18.15 retired that invariant outright (turn
 * exit now reads `lastAssistant.parentID === lastUser.id`, and
 * `MessageV2.latest()` orders by `time.created` with the id only as a
 * tie-break), and the range failed in both directions:
 *
 *   - **under-delete** — a reverted assistant message whose id happens to sort
 *     BELOW the boundary falls outside the interval, survives the commit,
 *     is orphaned, and reappears at the top of the chat;
 *   - **over-delete** — `ascendingId` stubs sit ~2.8e13 above every real id, so
 *     a single in-flight optimistic message pushed the watermark to
 *     effectively infinity and the interval swallowed the user's replacement
 *     prompt and its answer.
 *
 * Membership has neither failure. `hiddenIds` is the exact list of messages
 * that were part of the abandoned trajectory at the moment the rewind was
 * staged: nothing minted afterwards can enter it, and nothing inside it can
 * escape on an id comparison. `watermark` is retained as a published field —
 * it names the newest message known at stage time — and still answers
 * {@link isWithinRewindWindow} for a legacy state that carries no `hiddenIds`.
 */

export interface SessionRewindState {
  /** The message the rewind pointer sits at — hidden along with everything
   *  up to `watermark`. */
  messageId: string;
  /**
   * The newest message id known locally at the moment this rewind was staged
   * (or first observed) — see {@link newestMessageId}.
   *
   * No longer the upper bound of anything: {@link hiddenIds} is the window.
   * Retained because it is a published field, and because it is the only
   * bound available to a legacy state that carries no `hiddenIds`.
   */
  watermark: string;
  /**
   * The exact messages this rewind abandons — the boundary message and
   * everything that followed it in the transcript, captured ONCE at stage
   * time and never recomputed. Membership in this list is the whole of the
   * hide/delete test; see the module comment for the two failures the lexical
   * range it replaced produced.
   *
   * Optional only for backward compatibility: a `SessionRewindState` built by
   * an older consumer (or restored from one) has none, and falls back to the
   * legacy range. Everything in this SDK populates it.
   */
  hiddenIds?: readonly string[];
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

/** Whether `id` is one of the messages this rewind abandons.
 *
 *  Membership in the set captured at stage time — never a comparison between
 *  two id strings, which say nothing about which message came first. The
 *  legacy `[messageId, watermark]` range answers only for a state that
 *  carries no captured set. */
export function isWithinRewindWindow(id: string, rewind: SessionRewindState): boolean {
  if (rewind.hiddenIds) return rewind.hiddenIds.includes(id);
  return id >= rewind.messageId && id <= rewind.watermark;
}

/**
 * The newest message in `messages`, by `time.created` with the id as the only
 * tie-break — the same order the server's own `MessageV2.latest()` uses.
 * `null` for an empty list.
 *
 * Deliberately a max-scan, not "the last element": most callers pass an
 * ordered list, but an optimistic entry appended out of order must never win
 * by position alone. A message with no `time` cannot be dated, so it competes
 * on its id only.
 */
export function newestMessageId<
  T extends { info: { id: string; time?: { created?: number } } },
>(messages: T[]): string | null {
  let bestId: string | null = null;
  let bestCreated: number | undefined;
  for (const message of messages) {
    const { id } = message.info;
    const created = message.info.time?.created;
    if (bestId === null) {
      bestId = id;
      bestCreated = created;
      continue;
    }
    if (created !== undefined && bestCreated !== undefined) {
      if (created > bestCreated || (created === bestCreated && id > bestId)) {
        bestId = id;
        bestCreated = created;
      }
      continue;
    }
    if (created !== undefined && bestCreated === undefined) {
      bestId = id;
      bestCreated = created;
      continue;
    }
    if (created === undefined && bestCreated === undefined && id > bestId) {
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Build the state for a freshly staged (or freshly discovered) rewind.
 *
 * The window is captured HERE and never recomputed: `hiddenIds` is the
 * boundary message plus every message that follows it in `messages`, taken in
 * the order the caller holds them — which is the server's own
 * `time.created` page order, not an id order. Falls back to `messageId`
 * itself when the boundary is not in the list (a cross-tab or reload
 * discovery with no synced messages for this session), which hides only the
 * boundary message — the narrowest correct answer with no other information
 * available.
 */
export function stageSessionRewind<
  T extends { info: { id: string; time?: { created?: number } } },
>(messages: T[], messageId: string): SessionRewindState {
  const boundary = messages.findIndex((message) => message.info.id === messageId);
  const hiddenIds =
    boundary === -1 ? [messageId] : messages.slice(boundary).map((message) => message.info.id);
  return {
    messageId,
    watermark: newestMessageId(messages) ?? messageId,
    hiddenIds,
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
