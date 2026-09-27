'use client';

import { useSyncStore } from '../browser/stores/sync-store';
import {
  getSessionCacheOwnership,
  resolveSessionCacheOwnerScope,
  sessionCacheOwnerScopesConflict,
} from '../browser/session-sync/session-cache-ownership';
import type { MessageWithParts } from '../browser/stores/sync-store';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
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

/** Each part array's tool signature, computed once per array identity. */
const toolSignatures = new WeakMap<Part[], string>();

function toolSignature(parts: Part[] | undefined): string {
  if (!parts) return '';
  const cached = toolSignatures.get(parts);
  if (cached !== undefined) return cached;
  let signature = '';
  for (const part of parts) {
    if (part.type !== 'tool') continue;
    const input = (part.state as { input?: unknown }).input;
    const hasInput = !!input && typeof input === 'object' && Object.keys(input).length > 0;
    signature += `,${part.id}:${part.state.status}:${hasInput ? 1 : 0}`;
  }
  toolSignatures.set(parts, signature);
  return signature;
}

const SHAPE_CACHE_LIMIT = 20;
const shapeKeys = new Map<
  string,
  { messages: Message[]; partRefs: (Part[] | undefined)[]; key: string }
>();

/**
 * A string that changes when the transcript's SHAPE changes, and never when
 * only streamed text grows: the message ids in order, and each tool part's id,
 * status, and whether its input arrived. Lifecycle consumers subscribe to this
 * instead of the rows, so a `message.part.delta` does not re-render them, while
 * the checks they run over the transcript (message count, a running question or
 * permission-gated tool) still see every change that can flip their answer.
 *
 * Runs on every store change, so it is incremental: while the message list is
 * the same array, only part arrays whose identity moved are re-signed, and the
 * previous key is returned when none of their tool signatures changed.
 */
export function selectTranscriptShapeKey(state: SyncSnapshot, sessionId: string): string {
  const messages = state.messages[sessionId];
  if (!messages) return '';
  const cached = shapeKeys.get(sessionId);
  if (cached && cached.messages === messages) {
    let same = true;
    for (let i = 0; i < messages.length; i++) {
      const ref = state.parts[messages[i].id];
      if (ref === cached.partRefs[i]) continue;
      if (messages[i].role === 'assistant' && toolSignature(ref) !== toolSignature(cached.partRefs[i])) {
        same = false;
        break;
      }
      cached.partRefs[i] = ref;
    }
    if (same) return cached.key;
  }
  let key = `${messages.length}`;
  const partRefs: (Part[] | undefined)[] = [];
  for (const info of messages) {
    const parts = state.parts[info.id];
    partRefs.push(parts);
    key += `|${info.id}`;
    if (info.role === 'assistant') key += toolSignature(parts);
  }
  shapeKeys.delete(sessionId);
  shapeKeys.set(sessionId, { messages, partRefs, key });
  if (shapeKeys.size > SHAPE_CACHE_LIMIT) {
    const oldest = shapeKeys.keys().next().value;
    if (oldest !== undefined) shapeKeys.delete(oldest);
  }
  return key;
}
