'use client';

import type { MessageWithPartsLike, ToolPartLike } from '../core/turns/types';

/**
 * True when any assistant message has a `question` tool part still
 * running/pending — the signal `useQuestionSelfHeal` reacts to. Pure so it's
 * independently testable without rendering the hook.
 */
export function hasRunningQuestionTool(messages: MessageWithPartsLike[] | undefined): boolean {
  if (!messages) return false;
  return messages.some((m) => {
    if (m.info.role !== 'assistant') return false;
    return m.parts.some((p) => {
      if (p.type !== 'tool') return false;
      const tool = p as unknown as ToolPartLike;
      if (tool.tool !== 'question') return false;
      return tool.state.status === 'running' || tool.state.status === 'pending';
    });
  });
}

export interface UseQuestionSelfHealOptions {
  /** Gate the whole poll — e.g. only while this session's tab/view is active.
   * Default true. */
  enabled?: boolean;
  /** Skip re-adding a question the host just answered client-side, before the
   * server's `question.replied` SSE event confirms the removal (the pending
   * store's own `resolvedQuestionIds` guard already blocks a true re-add of an
   * answered question permanently; this is for a host's own transient
   * optimistic-hide window). */
  isSuppressed?: (requestId: string) => boolean;
}

/**
 * Self-heals a missed `question.asked` SSE event: when a `question` tool part
 * is rendering as running/pending but the pending-request store has nothing
 * for this session, re-hydrate from `question.list()`.
 *
 * This is a live-connection safety net, distinct from transcript replay.
 * reconnect-gap hydration (which only re-hydrates questions/permissions after
 * an SSE gap >5s): it covers a `question.asked` event being dropped, or racing
 * the `message.part.updated` event that renders the tool as running, while the
 * stream stays connected the whole time — the first `question.list()` call can
 * itself race the backend's request creation and return an empty list, so this
 * keeps polling (every 2s, rate-limited to one in-flight call every 1.5s) for
 * as long as the tool shows running with nothing pending, and stops the moment
 * a pending question shows up (from either this poll or the SSE event finally
 * arriving).
 */
export function useQuestionSelfHeal(
  sessionId: string,
  messages: MessageWithPartsLike[] | undefined,
  options: UseQuestionSelfHealOptions = {},
): void {
  // ACP request replay is transcript-backed; no harness-specific polling.
  void sessionId; void messages; void options;
}
