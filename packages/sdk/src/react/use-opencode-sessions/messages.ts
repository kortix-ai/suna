'use client';

import { useMutation } from '@tanstack/react-query';
import { getClient } from '../../opencode/client';
import { logger } from '../../platform/logger';
import { useSyncStore } from '../../state/sync-store';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { MessageWithParts, PromptPart, SendMessageOptions } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Send retry policy — ported from apps/web's `opencode-send-retry.ts` so every
// host that sends a prompt through `promptOpenCodeMessage` inherits it, not
// just apps/web.
//
// Two failure shapes flow through here:
//   1. A thrown error (transport failure — the request never completed). No
//      HTTP status is available.
//   2. A resolved SDK response carrying `{ error, response }` (the SDK resolves
//      rather than rejects on HTTP errors). `response.status` is the status.
//
// A freshly-created session points at a sandbox that may still be booting. The
// proxy comes up before opencode's binary binds its port, so it answers with a
// `503 "opencode not ready"` for a few seconds. That is a boot signal, not a
// real failure — retrying across the full boot window lets the first prompt
// land instead of flashing an "opencode not ready" error banner the user can't
// act on.
// ============================================================================

/** Generic transient blips (server restart, tunnel hiccup): short, snappy. */
const TRANSIENT_BACKOFF_MS = [400, 1000, 2000];

/**
 * Boot/wake window — covers a sandbox binding its opencode port, whether that's
 * a cold first-session boot OR a wake from auto-stop (sandbox resume + opencode
 * rebind, which is slower). Stretched to ~30s so the prompt lands instead of the
 * client giving up and reverting a message that actually ran once the box woke.
 */
const BOOT_BACKOFF_MS = [400, 800, 1500, 2500, 4000, 4000, 4000, 4000, 4000, 4000];

/** Pull a human-readable message out of any error/response-error shape. */
export function extractSendErrorMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') {
    const err = error as Record<string, any>;
    const root = err.data ?? err;
    const msg = root?.message || err.message || root?.error || err.error;
    if (typeof msg === 'string') return msg;
    try {
      return JSON.stringify(err);
    } catch {
      return '';
    }
  }
  return String(error);
}

/**
 * The sandbox proxy returns `503 "opencode not ready"` while opencode's binary
 * is still booting inside a freshly-created sandbox — or while a sandbox is
 * waking from auto-stop and rebinding its port. Match the common "not ready /
 * waking / booting / provisioning" shapes, not just the exact string.
 */
export function isOpenCodeNotReadyError(error: unknown): boolean {
  return /opencode not ready|not ready|not yet ready|waking|booting|still booting|provision/i.test(
    extractSendErrorMessage(error),
  );
}

/**
 * A status the server might recover from on its own: no status (thrown
 * transport error), any 5xx, or a 408/429 backpressure signal. A 4xx is a real
 * client error (bad request / auth / unknown model) and is never retried.
 */
export function isTransientSendStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

/**
 * Delay (ms) to wait before the next send attempt, or `null` when the send
 * should stop retrying and surface the error.
 *
 * @param attempt 1-based index of the attempt that just failed (1 = first send).
 *                The returned delay precedes attempt `attempt + 1`.
 */
export function getSendRetryDelayMs(
  attempt: number,
  status: number | undefined,
  error: unknown,
): number | null {
  // A 503 from our sandbox proxy ALWAYS means "sandbox/opencode not ready" — a
  // cold boot or a wake from auto-stop — so give it the full boot/wake window,
  // not the short transient one, even when the error body didn't carry a tidy
  // message. Giving up early here is exactly what reverted a prompt that then
  // landed once the box finished waking.
  const isBoot = status === 503 || isOpenCodeNotReadyError(error);
  const schedule = isBoot
    ? BOOT_BACKOFF_MS
    : isTransientSendStatus(status)
      ? TRANSIENT_BACKOFF_MS
      : null;
  if (!schedule) return null;
  if (attempt < 1 || attempt > schedule.length) return null;
  return schedule[attempt - 1];
}

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

export interface SendOpenCodeMessageArgs {
  sessionId: string;
  parts: PromptPart[];
  options?: SendMessageOptions;
  messageID?: string;
}

/** Error thrown by `promptOpenCodeMessage` on a non-2xx response — carries the
 * HTTP status (mirroring `response`/`status` so `parseBillingError` can detect
 * a 402) alongside the raw error payload. */
export interface SendOpenCodeMessageError extends Error {
  status?: number;
  response?: { status: number };
  data?: unknown;
}

/**
 * Send a prompt to a session via `session.promptAsync()` — the server accepts
 * the prompt and returns immediately (204); the actual turn streams back over
 * SSE into the sync store. Callers must NOT await this for the turn to finish,
 * only for the server's accept/reject of the prompt itself.
 *
 * Retries transient failures (a thrown transport error, or a 5xx/408/429
 * response) with backoff — see the retry policy above. The sandbox proxy's
 * `503 "opencode not ready"` boot signal gets the full ~30s boot/wake window so
 * the very first prompt against a cold or waking sandbox lands on its own
 * instead of surfacing an error the user can't act on. A real 4xx (bad
 * request / auth / unknown model) is never retried.
 *
 * `getClient()` is resolved INSIDE the retry loop (not once up front) so its
 * own "Server URL not ready" throw — the runtime url not pinned yet, which a
 * brand-new session's very first prompt can race — gets the same boot-window
 * retry treatment instead of propagating instantly with zero retries.
 *
 * Extracted from `useSendOpenCodeMessage`'s mutationFn so it's a plain async
 * function callable — and unit-testable — without a mutation/hook context.
 */
export async function promptOpenCodeMessage({
  sessionId,
  parts,
  options,
  messageID,
}: SendOpenCodeMessageArgs): Promise<void> {
  const mappedParts = parts.map((p) => {
    if (p.type === 'file') return { type: 'file' as const, mime: p.mime, url: p.url, filename: p.filename, source: p.source };
    if (p.type === 'agent') return { type: 'agent' as const, name: p.name, source: p.source };
    return { type: 'text' as const, text: p.text };
  });
  const payload = {
    sessionID: sessionId,
    parts: mappedParts,
    ...(messageID && { messageID }),
    ...(options?.directory && { directory: options.directory }),
    ...(options?.model && { model: options.model }),
    ...(options?.agent && { agent: options.agent }),
    ...(options?.variant && { variant: options.variant }),
  };

  for (let attempt = 1; ; attempt++) {
    let status: number | undefined;
    let error: unknown;
    try {
      // Resolve the client INSIDE the retry loop, not once before it. During
      // the sandbox-loading window `getClient()` throws "Server URL not
      // ready" (see opencode/client.ts) — that's a boot-phase condition
      // exactly like the proxy's 503 "opencode not ready" below, so it must
      // participate in the SAME boot/wake retry window rather than propagate
      // instantly with zero retries. A brand-new session's very first prompt
      // can race the runtime url being pinned; without this the send throws
      // before a single retry and the prompt is dropped.
      const client = getClient();
      // The SDK resolves (not rejects) on HTTP errors, returning
      // { error, response } instead of throwing.
      const result = await client.session.promptAsync(payload as any);
      if (!result?.error) return; // 204 — server accepted the prompt.
      error = result.error;
      status = (result.response as Response | undefined)?.status;
    } catch (err) {
      error = err; // thrown = transport failure (no status) OR getClient() not-ready.
    }

    const delay = getSendRetryDelayMs(attempt, status, error);
    if (delay === null) {
      const err = error as any;
      const message = err?.data?.message || err?.message || 'Failed to send message';
      const wrapped = new Error(message) as SendOpenCodeMessageError;
      if (status) {
        wrapped.status = status;
        wrapped.response = { status };
      }
      wrapped.data = err?.data ?? err;
      throw wrapped;
    }
    logger.warn('promptOpenCodeMessage retrying send', { sessionId, attempt, status });
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export function useSendOpenCodeMessage() {
  return useMutation({ mutationFn: promptOpenCodeMessage });
}

export function useAbortOpenCodeSession() {
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = getClient();
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
