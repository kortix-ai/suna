'use client';

import { useEffect, useMemo, useRef } from 'react';
import { getClient } from '../opencode/client';
import { useOpenCodePendingStore } from '../state/opencode-pending-store';
import type { MessageWithPartsLike, ToolPartLike } from '../turns/types';

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
 * This is a LIVE-CONNECTION safety net, distinct from `useOpenCodeEventStream`'s
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
  const { enabled = true, isSuppressed } = options;
  const addQuestion = useOpenCodePendingStore((s) => s.addQuestion);
  const pendingCount = useOpenCodePendingStore((s) =>
    Object.values(s.questions).filter((q) => q.sessionID === sessionId && !isSuppressed?.(q.id))
      .length,
  );
  const running = useMemo(() => hasRunningQuestionTool(messages), [messages]);

  const inFlightRef = useRef(false);
  const lastAtRef = useRef(0);
  useEffect(() => {
    if (!enabled || !running || pendingCount > 0) return;

    let cancelled = false;

    const hydrate = () => {
      if (inFlightRef.current || cancelled) return;
      const now = Date.now();
      if (now - lastAtRef.current < 1500) return;

      // Acquire the client lazily: during the sandbox-loading window
      // getClient() throws "Server URL not ready". Skip this tick and let the
      // interval retry once the runtime URL is pinned — never throw here.
      let client: ReturnType<typeof getClient>;
      try {
        client = getClient();
      } catch {
        return;
      }

      inFlightRef.current = true;
      lastAtRef.current = now;

      void client.question
        .list()
        .then((res) => {
          if (!res.data || cancelled) return;
          (res.data as Array<{ id?: string }>).forEach((q) => {
            if (!q?.id || isSuppressed?.(q.id)) return;
            addQuestion(q as Parameters<typeof addQuestion>[0]);
          });
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    };

    hydrate();
    const timer = setInterval(hydrate, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, running, pendingCount, addQuestion, isSuppressed]);
}
