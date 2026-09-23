'use client';

import { useSyncStore } from '../browser/stores/sync-store';
import {
  getSessionCacheOwnership,
  resolveSessionCacheOwnerScope,
  sessionCacheOwnerScopesConflict,
} from '../browser/session-sync/session-cache-ownership';
import type { MessageWithParts } from '../browser/stores/sync-store';
import { useCurrentRuntime } from './use-current-runtime';

/**
 * Internal. Not re-exported from any barrel.
 *
 * The one rule for "which OpenCode id may this tab READ": a transcript cached
 * for another runtime (equal OpenCode ids in different sandboxes) is not this
 * session's, so it reads as absent. `useSessionSync` and `useSessionMessages`
 * both gate on it, so the two can never disagree.
 */
export function useReadableSessionId(sessionId: string, kortixSessionScope?: string): string {
  const runtimeScope = useCurrentRuntime((state) => state.sandboxId) ?? 'none';
  const cacheOwnerScope = resolveSessionCacheOwnerScope(runtimeScope, kortixSessionScope);
  const currentOwner = getSessionCacheOwnership(sessionId);
  const cacheBelongsToAnotherRuntime =
    !!sessionId && sessionCacheOwnerScopesConflict(currentOwner, cacheOwnerScope);
  return cacheBelongsToAnotherRuntime ? '' : sessionId;
}

type SyncSnapshot = ReturnType<typeof useSyncStore.getState>;

/** The joined rows for `sessionId` from one store snapshot. */
export function selectSessionRows(state: SyncSnapshot, sessionId: string): MessageWithParts[] {
  return state.buildSessionMessages(sessionId, state.messages[sessionId], state.parts);
}

/**
 * A string that changes when the transcript's SHAPE changes, and never when
 * only streamed text grows: the message ids in order, and each tool part's id,
 * status, and whether its input arrived. Lifecycle consumers subscribe to this
 * instead of the rows, so a `message.part.delta` does not re-render them, while
 * the checks they run over the transcript (message count, a running question or
 * permission-gated tool) still see every change that can flip their answer.
 */
export function selectTranscriptShapeKey(state: SyncSnapshot, sessionId: string): string {
  const messages = state.messages[sessionId];
  if (!messages) return '';
  let key = `${messages.length}`;
  for (const info of messages) {
    key += `|${info.id}`;
    if (info.role !== 'assistant') continue;
    const parts = state.parts[info.id];
    if (!parts) continue;
    for (const part of parts) {
      if (part.type !== 'tool') continue;
      const input = (part.state as { input?: unknown }).input;
      const hasInput = !!input && typeof input === 'object' && Object.keys(input).length > 0;
      key += `,${part.id}:${part.state.status}:${hasInput ? 1 : 0}`;
    }
  }
  return key;
}
