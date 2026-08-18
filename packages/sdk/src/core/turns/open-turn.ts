/**
 * Is the last assistant turn still open? — the one shared predicate.
 *
 * This existed twice, and the two copies disagreed:
 *
 * - The sandbox daemon
 *   (`apps/kortix-sandbox-agent-server/src/opencode-turn-state.ts:89-93`) keeps a
 *   turn open through a RETRYABLE error:
 *   `role === 'assistant' && !time.completed && (!error || error.data?.isRetryable === true)`.
 * - `apps/web`'s copy ended the turn on ANY `info.error`. That was the wrong one.
 *   During a provider 429 backoff OpenCode stamps `info.error` and keeps writing
 *   the SAME assistant message, so the web opened the queue's drain gate and sent
 *   the next queued message into a turn that was still running.
 *
 * The daemon is the reference implementation. This file exists so there is one
 * predicate to drift from instead of two to keep in sync — per the repo rule that
 * logic lives in the SDK and hosts are thin.
 *
 * The other half of the rule must survive the move: an ABORTED turn — an error
 * with no `time.completed` — reads as CLOSED. `applyOptimisticAbort` in `apps/web`
 * marks the message with an `AbortError` and never sets `time.completed`, and an
 * aborted turn may never receive a `message.updated` that does. Reading only
 * `time.completed` therefore stayed true for the lifetime of the tab after the
 * stop button, and every message typed afterwards queued behind one that could
 * never be released. A turn ends two ways: it completes, or it is terminally
 * interrupted. A retryable error is neither.
 *
 * No imports, no globals — `core/turns` is `isomorphic-core`.
 */

/**
 * The shape this predicate needs. Wider message types satisfy it structurally.
 *
 * `time` carries an index signature deliberately: a user message's `time` is
 * `{ created: number }`, which shares no property with `{ completed?: number }`,
 * and TypeScript rejects an assignment between object types with no overlap.
 * The index signature says "other keys are allowed and I do not care".
 */
export interface OpenTurnMessageLike {
  info: {
    role: string;
    id?: string;
    time?: { completed?: number | null; [key: string]: unknown } | null;
    error?: unknown;
  };
}

/**
 * Is this turn error a RETRY in progress rather than an ending?
 *
 * OpenCode stamps `info.error` on the live assistant message while it backs off
 * a 429 or a transient upstream 5xx, then keeps writing the SAME message. Only
 * `data.isRetryable === true` means that — the `ApiError` variant is the only
 * one carrying the flag; `AbortError`, `MessageAbortedError`, `ProviderAuthError`,
 * `ContentFilterError`, and `UnknownError` have no `isRetryable` and are terminal.
 * Strict `=== true`: a missing field, a truthy string, or an error with no `data`
 * is terminal.
 */
export function isRetryableTurnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const data = (error as { data?: { isRetryable?: unknown } }).data;
  return !!data && typeof data === 'object' && data.isRetryable === true;
}

/**
 * Is the last assistant message still open?
 *
 * A turn ends two ways: it completes, or it is terminally interrupted. A
 * retryable error is NEITHER — the same message is still being written.
 */
export function hasOpenAssistantTurn(
  messages: readonly OpenTurnMessageLike[] | undefined,
): boolean {
  if (!messages?.length) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info.role !== 'assistant') continue;
    return !info.time?.completed && (!info.error || isRetryableTurnError(info.error));
  }
  return false;
}

/**
 * Is the last assistant turn open BECAUSE the provider is being retried?
 *
 * The narrow half of `hasOpenAssistantTurn`, and the only half that carries
 * proof. That predicate is true for two very different things:
 *
 *  * a turn mid-retry — OpenCode stamped `data.isRetryable === true` and is
 *    still writing the same message. Evidence of a LIVE turn, whatever the
 *    session's status frame says, and refusing to send into it is the rule the
 *    shared predicate was extracted for;
 *  * a HUSK — a message left open by a sandbox that died mid-turn, with no
 *    error and no `time.completed`, which no later event ever closes. It lives
 *    in the server's transcript, so it survives a reload, and gating a send on
 *    it wedges the composer for the lifetime of the session. That is exactly
 *    what needed a 10s clock and a confirmation round-trip to work around.
 *
 * A husk has no error at all, so this is false for it by construction.
 */
export function hasRetryingAssistantTurn(
  messages: readonly OpenTurnMessageLike[] | undefined,
): boolean {
  if (!messages?.length) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info.role !== 'assistant') continue;
    return !info.time?.completed && isRetryableTurnError(info.error);
  }
  return false;
}
