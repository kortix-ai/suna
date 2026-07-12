'use client';

import { useEffect, useMemo, useRef } from 'react';
import { getClient } from '../core/runtime/client';
import { useRuntimePendingStore } from '../browser/stores/runtime-pending-store';
import type { MessageWithPartsLike, ToolPartLike } from '../core/turns/types';

/** A tool stuck in `running` this long with nothing pending is suspicious —
 * long enough that ordinary tool startup never trips it. */
const STALE_RUNNING_MS = 10_000;

/**
 * Classify tool parts that could be blocked on an unanswered permission ask.
 * Unlike questions (their own `question` tool), a permission can gate ANY tool
 * (bash, edit, write, …), so the signal is fuzzier — two shapes qualify:
 *
 * - `pending` with non-empty input: args are fully streamed but execution never
 *   started. Transiently true for every tool for a frame or two, durably true
 *   for one blocked on a permission ask. (`pending` with EMPTY input is the
 *   known "session ended abruptly" stale shape — ignored.)
 * - `running` for a long time: covers opencode versions/tools where a blocked
 *   part reports `running`. Fuzzy on purpose — a long bash command looks the
 *   same — so callers poll this shape on a much slower cadence.
 *
 * Returns which shapes are present so the hook can pick a poll cadence.
 */
export function findPermissionBlockedCandidate(
  messages: MessageWithPartsLike[] | undefined,
  now: number,
): { pendingWithInput: boolean; staleRunning: boolean } {
  let pendingWithInput = false;
  let staleRunning = false;
  if (!messages) return { pendingWithInput, staleRunning };
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    for (const p of m.parts) {
      if (p.type !== 'tool') continue;
      const tool = p as unknown as ToolPartLike;
      // Questions have their own self-heal (`useQuestionSelfHeal`).
      if (tool.tool === 'question') continue;
      const state = tool.state as {
        status?: string;
        input?: Record<string, unknown>;
        time?: { start?: number };
      };
      if (state.status === 'pending' && Object.keys(state.input ?? {}).length > 0) {
        pendingWithInput = true;
      } else if (state.status === 'running') {
        const start = state.time?.start;
        if (typeof start === 'number' && now - start > STALE_RUNNING_MS) staleRunning = true;
      }
    }
  }
  return { pendingWithInput, staleRunning };
}

/** True when any non-question tool part is still running/pending — the cheap
 * render-time gate that keeps the poll effect mounted at all. */
export function hasActiveNonQuestionTool(messages: MessageWithPartsLike[] | undefined): boolean {
  if (!messages) return false;
  return messages.some((m) => {
    if (m.info.role !== 'assistant') return false;
    return m.parts.some((p) => {
      if (p.type !== 'tool') return false;
      const tool = p as unknown as ToolPartLike;
      if (tool.tool === 'question') return false;
      return tool.state.status === 'running' || tool.state.status === 'pending';
    });
  });
}

export interface UsePermissionSelfHealOptions {
  /** Gate the whole poll — e.g. only while this session's tab/view is active.
   * Default true. */
  enabled?: boolean;
}

/**
 * Self-heals a missed `permission.asked` SSE event — the permission twin of
 * `useQuestionSelfHeal`, closing the gap where a dropped frame leaves the agent
 * silently blocked on an ask the user never sees (the "have to type `continue`
 * to unwedge it" failure).
 *
 * Because a permission can gate any tool, the trigger is fuzzier than the
 * question hook's, so the cadence is shape-dependent (see
 * `findPermissionBlockedCandidate`): a `pending`-with-input part re-checks
 * `permission.list()` every ~2s like the question hook; a merely long-`running`
 * part — which a legitimate slow bash command also produces — is probed at most
 * every 15s so an active session never gets hammered. The poll stops the moment
 * a pending permission shows up (from this poll or the SSE event finally
 * arriving) or the tool part settles.
 */
export function usePermissionSelfHeal(
  sessionId: string,
  messages: MessageWithPartsLike[] | undefined,
  options: UsePermissionSelfHealOptions = {},
): void {
  const { enabled = true } = options;
  const addPermission = useRuntimePendingStore((s) => s.addPermission);
  const pendingCount = useRuntimePendingStore(
    (s) => Object.values(s.permissions).filter((p) => p.sessionID === sessionId).length,
  );
  const active = useMemo(() => hasActiveNonQuestionTool(messages), [messages]);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const inFlightRef = useRef(false);
  const lastAtRef = useRef(0);
  useEffect(() => {
    if (!enabled || !active || pendingCount > 0) return;

    let cancelled = false;

    const hydrate = () => {
      if (inFlightRef.current || cancelled) return;
      const now = Date.now();
      // Evaluate the blocked-candidate shapes at poll time, not render time —
      // a part silently aging past the stale threshold produces no re-render.
      const { pendingWithInput, staleRunning } = findPermissionBlockedCandidate(
        messagesRef.current,
        now,
      );
      if (!pendingWithInput && !staleRunning) return;
      const minGap = pendingWithInput ? 1_500 : 15_000;
      if (now - lastAtRef.current < minGap) return;

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

      void client.permission
        .list()
        .then((res) => {
          if (!res.data || cancelled) return;
          (res.data as Array<{ id?: string }>).forEach((p) => {
            if (!p?.id) return;
            addPermission(p as Parameters<typeof addPermission>[0]);
          });
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    };

    hydrate();
    const timer = setInterval(hydrate, 2_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, active, pendingCount, addPermission]);
}
