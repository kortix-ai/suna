'use client';

import { useMutation } from '@tanstack/react-query';
import { getClient, type OpencodeClient } from '../../opencode/client';
import { useSyncStore } from '../../state/sync-store';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { MessageWithParts, PromptPart, SendMessageOptions } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Messages
// ============================================================================

/**
 * Get messages for a session.
 *
 * CONSOLIDATED: Now reads from the Zustand sync store (single source of truth)
 * instead of making its own independent React Query fetch. The sync store is
 * populated by useSessionSync on mount and kept live by SSE events.
 *
 * Previously this was an independent React Query hook with its own queryFn that
 * called client.session.messages() — duplicating the exact same fetch that
 * useSessionSync already makes. This caused 2x /session/{id}/message requests
 * on every session navigation.
 *
 * Returns a shape compatible with the old UseQueryResult<MessageWithParts[]>
 * for backward compatibility with consumers (session-layout, tool-renderers,
 * snapshot-dialog, session-diff-viewer).
 */
/**
 * Message cache for useOpenCodeMessages — prevents creating new array references
 * on every render. Same pattern as buildMessages() in use-session-sync.ts.
 * Without this, the Zustand selector returns a new array from .map() on every
 * call, breaking useSyncExternalStore's Object.is check → infinite re-render.
 */
const MSG_HOOK_CACHE_MAX = 20;
const msgHookCache = new Map<
  string,
  {
    msgs: Message[] | undefined;
    partRefs: (Part[] | undefined)[];
    result: MessageWithParts[];
  }
>();

function touchMsgHookCache(sessionId: string) {
  const entry = msgHookCache.get(sessionId);
  if (entry) {
    msgHookCache.delete(sessionId);
    msgHookCache.set(sessionId, entry);
  }
  if (msgHookCache.size > MSG_HOOK_CACHE_MAX) {
    const oldest = msgHookCache.keys().next().value;
    if (oldest) msgHookCache.delete(oldest);
  }
}

const EMPTY_MSGS: MessageWithParts[] = [];

function buildMsgsForHook(
  sessionId: string,
  msgs: Message[] | undefined,
  parts: Record<string, Part[]>,
): MessageWithParts[] {
  if (!msgs || msgs.length === 0) return EMPTY_MSGS;

  const cached = msgHookCache.get(sessionId);
  if (cached && cached.msgs === msgs) {
    let same = cached.partRefs.length === msgs.length;
    if (same) {
      for (let i = 0; i < msgs.length; i++) {
        if (parts[msgs[i].id] !== cached.partRefs[i]) {
          same = false;
          break;
        }
      }
    }
    if (same) return cached.result;
  }

  const partRefs: (Part[] | undefined)[] = [];
  const result: MessageWithParts[] = [];
  for (const info of msgs) {
    const pa = parts[info.id];
    partRefs.push(pa);
    result.push({ info, parts: pa ?? [] });
  }
  msgHookCache.set(sessionId, { msgs, partRefs, result });
  touchMsgHookCache(sessionId);
  return result;
}

export function useOpenCodeMessages(sessionId: string) {
  // Select via a referentially-stable selector that uses an external cache.
  // getMessages() in the store creates new arrays via .map() on every call,
  // which breaks useSyncExternalStore → infinite loop. buildMsgsForHook()
  // returns the same reference if nothing changed for this session.
  const messages = useSyncStore((s) =>
    buildMsgsForHook(sessionId, s.messages[sessionId], s.parts),
  );
  const isLoading = !useSyncStore((s) => sessionId in s.messages);

  return {
    data: messages.length > 0 ? messages : undefined,
    isLoading,
    isError: false,
    error: null,
    refetch: async () => ({ data: messages } as any),
  };
}

// ============================================================================
// Prompt / Abort Hooks
// ============================================================================

/**
 * Generate a monotonic ascending ID compatible with the server's Identifier.ascending().
 * Server format: prefix + "_" + 12-char hex timestamp + 14-char random base62 = prefix_<26 chars>
 * Server validates: z.string().startsWith("msg") for messages, "prt" for parts.
 */
let lastIdTimestamp = 0;
let idCounter = 0;
export function ascendingId(prefix: 'msg' | 'prt' = 'msg'): string {
  const now = Date.now();
  if (now !== lastIdTimestamp) {
    lastIdTimestamp = now;
    idCounter = 0;
  }
  idCounter++;
  const encoded = BigInt(now) * BigInt(0x1000) + BigInt(idCounter);
  const hex = encoded.toString(16).padStart(12, '0').slice(0, 12);
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let rand = '';
  for (let i = 0; i < 14; i++) rand += chars[Math.floor(Math.random() * 62)];
  return `${prefix}_${hex}${rand}`;
}

export function useSendOpenCodeMessage(clientOverride?: OpencodeClient) {
  return useMutation({
    mutationFn: async ({
      sessionId,
      parts,
      options,
      messageID,
    }: {
      sessionId: string;
      parts: PromptPart[];
      options?: SendMessageOptions;
      messageID?: string;
    }) => {
      const mappedParts = parts.map((p) => {
        if (p.type === 'file') return { type: 'file' as const, mime: p.mime, url: p.url, filename: p.filename, source: p.source };
        if (p.type === 'agent') return { type: 'agent' as const, name: p.name, source: p.source };
        return { type: 'text' as const, text: p.text };
      });
      const payload = {
        sessionID: sessionId,
        parts: mappedParts,
        ...(messageID && { messageID }),
        ...(options?.model && { model: options.model }),
        ...(options?.agent && { agent: options.agent }),
        ...(options?.variant && { variant: options.variant }),
      };

      // Match OpenCode exactly: use session.prompt() (blocking endpoint).
      // The call blocks until the AI finishes, but we fire-and-forget from
      // the UI side (handleSend doesn't await the mutation result).
      // SSE events drive all incremental UI updates via the sync store.
      // Per-session client when useSession supplies one (getClientForUrl(runtime_url)),
      // else the global active-server client. Same URL for a single active session.
      const client = clientOverride ?? getClient();
      const result = await client.session.prompt(payload as any);
      if (result.error) {
        const err = result.error as any;
        throw new Error(err?.data?.message || err?.message || 'Failed to send message');
      }
    },
  });
}

export function useAbortOpenCodeSession(clientOverride?: OpencodeClient) {
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = clientOverride ?? getClient();
      const result = await client.session.abort({ sessionID: sessionId });
      unwrap(result);
      // After abort succeeds, the SSE stream should deliver session.idle event.
      // If the UI stays stuck, it means the SSE event wasn't received/processed.
      // The optimistic idle status we set in handleStop should handle this, but
      // if for some reason the abort HTTP call returned but SSE didn't update,
      // we force-refresh the session status from the server.
      try {
        const statusResult = await client.session.status();
        const statuses = statusResult.data as Record<string, any>;
        const serverStatus = statuses[sessionId];
        if (serverStatus && serverStatus.type !== 'idle') {
          // Server still thinks we're busy - update the store with server's view
          // This can happen if SSE events were missed
          useSyncStore.getState().setStatus(sessionId, serverStatus);
        }
      } catch {
        // Non-critical — SSE will eventually deliver the correct status
      }
    },
    retry: 2,
    retryDelay: 300,
    onError: () => {},
  });
}
