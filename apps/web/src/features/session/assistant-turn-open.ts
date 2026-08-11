/**
 * Whether the last assistant message is still open.
 *
 * This is one of the queue's drain gates, and it used to be a single inline
 * expression in `session-chat.tsx`: `!lastAssistant.time?.completed`. That
 * expression has a hole, and the hole wedges the queue permanently.
 *
 * Pressing stop calls `applyOptimisticAbort`, which marks the last assistant
 * message with an `AbortError` and flips the session idle — but never sets
 * `time.completed`, and an aborted turn may never receive a `message.updated`
 * that does. So after every interrupt the old expression stayed `true` for the
 * lifetime of the tab, `canDrainQueue` stayed `false`, and every message typed
 * afterwards queued behind one that could never be released. The user sees a
 * queue that has simply stopped working, with nothing on screen explaining why.
 *
 * A turn ends two ways: it finishes, or it is interrupted. Both are ended.
 */

/**
 * The shape this predicate needs. Wider message types satisfy it structurally.
 *
 * `time` carries an index signature deliberately. A user message's `time` is
 * `{ created: number }`, which shares no property with `{ completed?: number }`
 * — and TypeScript rejects an assignment between object types with no overlap
 * as a likely mistake, so the narrow declaration made the whole `messages`
 * array unassignable. The index signature says "other keys are allowed and I do
 * not care about them", which is exactly true here.
 */
export interface AssistantTurnMessage {
  info: {
    role: string;
    time?: { completed?: number | null; [key: string]: unknown } | null;
    error?: unknown;
  };
}

export function hasOpenAssistantTurn(messages: AssistantTurnMessage[] | undefined): boolean {
  if (!messages?.length) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info.role !== 'assistant') continue;
    return !info.time?.completed && !info.error;
  }
  return false;
}
