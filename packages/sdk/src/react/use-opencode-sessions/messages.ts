'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getClient } from '../../core/runtime/client';
import { logger } from '../../core/http/logger';
import { useSyncStore } from '../../browser/stores/sync-store';
import type { PromptPart, SendMessageOptions } from './keys';
import { canQueryOpenCodeSession, unwrap } from './shared';

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
    const err = error as Record<string, unknown>;
    const root = (err.data as Record<string, unknown> | undefined) ?? err;
    const msg = root.message || err.message || root.error || err.error;
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
export function useOpenCodeMessages(sessionId: string) {
  // Hold this session's transcript for as long as this hook is mounted.
  //
  // Not optional bookkeeping: the store frees a session once its last consumer
  // is gone, and this hook has consumers that are NOT the session view — a
  // parent transcript previews a spawned child session through it (task-tool,
  // session-spawn-tool). A child the user had opened directly, and has since
  // navigated away from, is otherwise a legitimate eviction candidate while
  // that preview is still on screen; those previews have no re-hydrate path of
  // their own, so they would simply go empty.
  //
  // Guarded exactly like use-session-sync.ts. Callers pass Kortix route ids
  // here as well as OpenCode ids — a booting session renders this hook with the
  // project-session UUID — and those can never hold runtime data. Retaining one
  // would park a permanently empty id in the detach window on unmount, spending
  // a slot and evicting a real transcript one navigation early.
  useEffect(() => {
    if (!canQueryOpenCodeSession(sessionId)) return;
    return useSyncStore.getState().retainSession(sessionId);
  }, [sessionId]);

  // Select via the store's shared, referentially-stable join. getMessages()
  // rebuilds via .map() on every call, which breaks useSyncExternalStore's
  // Object.is check → infinite re-render. This hook used to keep its own copy
  // of that memo, which meant an evicted session stayed reachable through it;
  // the store owns the memo now, beside the eviction that invalidates it.
  const messages = useSyncStore((s) =>
    s.buildSessionMessages(sessionId, s.messages[sessionId], s.parts),
  );
  const isLoading = !useSyncStore((s) => sessionId in s.messages);

  return {
    data: messages.length > 0 ? messages : undefined,
    isLoading,
    isError: false,
    error: null,
    refetch: async () => ({ data: messages }),
  };
}

// ============================================================================
// Prompt / Abort Hooks
// ============================================================================

/**
 * Generate a monotonic ascending ID compatible with the server's Identifier.ascending().
 * Server format: prefix + "_" + 12-char hex timestamp + 14-char random base62 = prefix_<26 chars>
 * Server validates: z.string().startsWith("msg") for messages, "prt" for parts.
 *
 * ⚠️ **The time field is NOT comparable with a server-minted id, despite the
 * name.** opencode encodes the LOW 6 bytes of `Date.now() * 0x1000 + counter`;
 * this keeps the HIGH 12 hex digits of the same number (`.slice(0, 12)` of a
 * 14-digit string, i.e. a divide by 256). Today that yields `msg_19ff…` where
 * opencode mints `msg_fa4a…`, so EVERY id from here sorts before EVERY id from
 * the server. Local-only ids (an optimistic message a host renders while its
 * prompt is in flight) do not care. **Anything that goes on the wire does** —
 * use `mintPromptMessageId` below, which encodes the field the way opencode
 * does. Left as-is on purpose: this is a published export, and hosts key
 * optimistic state on the exact strings it returns.
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

// ─────────────────────────────────────────────────────────────────────────────
// One prompt submission = one client-minted `messageID`.
//
// The Kortix sandbox proxy refuses to deliver a prompt body it may already have
// delivered. It identifies a delivery by the caller's `Idempotency-Key` header
// or — when there is none, which is always for a browser, since that header is
// not on the API's CORS allow-list — by a **sha256 of the request body**, with a
// 60s TTL (`apps/api/src/sandbox-proxy/prompt-dedupe.ts`, `promptDeliveryKey`).
// A repeat is answered `200 {"status":"duplicate","deduplicated":true}` and
// never reaches opencode.
//
// The payload below is built from the session id, the mapped parts (whose
// client ids are dropped), and the model/agent picks — nothing else. So sending
// the same text twice within 60s produced a BYTE-IDENTICAL body, and the second
// submission was silently lost: no error, no turn, nothing on screen. Minting a
// per-submission id makes the two bodies differ by construction, while a RETRY
// of one submission keeps its id so the proxy's real duplicate protection still
// fires (see the retry loop in `promptOpenCodeMessage`).
//
// "One submission" is bigger than one call. The internal retry loop is only the
// retry the SDK owns; a host retries too — apps/web's message queue re-dispatches
// a failed entry through `retry` → `sendQueuedMessage` → `handleSend` →
// `sendParts`, which lands here as a FRESH call. Minting per call there would
// deliver a prompt that reached opencode but reported failure a SECOND time, and
// the second prompt aborts the turn the first one started. So the caller may
// name its submission with `clientMessageId` — the queue entry's own stable key
// (`QueuedMessageInput.clientMessageId`) — and every dispatch of that submission
// resolves to the one wire id.
//
// The caller names the submission; this module still owns the wire FORMAT.
// A host id (`cm_12`, or `ascendingId`'s `msg_19ff…`, which encodes the wrong
// bits — see the warning on it) cannot be used on the wire: opencode orders by
// the id's clock prefix, so a badly-shaped id reads as already-answered and the
// turn never runs.
// ─────────────────────────────────────────────────────────────────────────────

// `BigInt(0x…)` rather than the `0x…n` literal, throughout. This package is
// typechecked by its consumers as well as by itself, and apps/web's tsconfig
// targets below ES2020, where the literal syntax is `TS2737: BigInt literals
// are not available`. The call form compiles under every target and is exact —
// each value below is far inside `Number.MAX_SAFE_INTEGER`.
/** opencode keeps the low 6 bytes of its id clock, so the field wraps ~every 2.2y. */
const WIRE_ID_TIME_MASK = BigInt(0xffffffffffff);
/** Sub-millisecond slots per millisecond in that clock (`Date.now() * 0x1000`). */
const WIRE_ID_TIME_SCALE = BigInt(0x1000);
/**
 * Ceiling on the correction taken from the session's own transcript: 1h of
 * clock. Large enough to absorb any realistic browser-vs-sandbox skew, small
 * enough that one wrapped or malformed id cannot drag every later id weeks into
 * the future.
 */
const MAX_WIRE_ID_CLOCK_CORRECTION = BigInt(60 * 60 * 1000) * WIRE_ID_TIME_SCALE;
const WIRE_MESSAGE_ID_TIME = /^msg_([0-9a-f]{12})/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Monotonic tie-break for two submissions inside the same millisecond. Scoped
// to the LAST session deliberately: a skew correction learned from one
// session's transcript must not follow the user into another session, where it
// would push a fresh user message past assistant replies that come after it.
let lastMintedSessionId = '';
let lastMintedWireId = BigInt(0);

/** The highest id-clock value this session's transcript already shows, or null. */
function newestKnownMessageTime(sessionId: string): bigint | null {
  const messages = useSyncStore.getState().messages[sessionId];
  if (!messages?.length) return null;
  let newest: bigint | null = null;
  for (const message of messages) {
    const match = WIRE_MESSAGE_ID_TIME.exec(message?.id ?? '');
    if (!match) continue;
    const encoded = BigInt(`0x${match[1]}`);
    if (newest === null || encoded > newest) newest = encoded;
  }
  return newest;
}

/**
 * Mint the `messageID` for ONE prompt submission, in opencode's own
 * `Identifier.ascending("message")` wire format: `msg_` + the low 48 bits of
 * `Date.now() * 0x1000` as 12 hex chars + 14 random base62 chars.
 *
 * Ordering is load-bearing, which is why this does not reuse `ascendingId`
 * (see the warning on it): opencode resolves "has this prompt already been
 * answered?" by id order, so a user message that sorts before the assistant
 * replies already on record is read as answered and the turn never runs — the
 * same silent loss this whole change exists to remove. Two guards keep the
 * minted id above everything already known:
 *
 *  1. If this session's transcript already holds a HIGHER id — the browser
 *     clock lags the sandbox's — start just above it, bounded by
 *     {@link MAX_WIRE_ID_CLOCK_CORRECTION}.
 *  2. Never repeat or go below the previous id minted for this same session,
 *     so two submissions inside one millisecond still order.
 */
function mintPromptMessageId(sessionId: string): string {
  let encoded = (BigInt(Date.now()) * WIRE_ID_TIME_SCALE) & WIRE_ID_TIME_MASK;
  const newest = newestKnownMessageTime(sessionId);
  if (newest !== null && newest >= encoded && newest - encoded <= MAX_WIRE_ID_CLOCK_CORRECTION) {
    encoded = newest + BigInt(1);
  }
  if (sessionId === lastMintedSessionId && encoded <= lastMintedWireId) {
    encoded = lastMintedWireId + BigInt(1);
  }
  encoded &= WIRE_ID_TIME_MASK;
  lastMintedSessionId = sessionId;
  lastMintedWireId = encoded;

  let random = '';
  for (let i = 0; i < 14; i++) random += BASE62[Math.floor(Math.random() * 62)];
  return `msg_${encoded.toString(16).padStart(12, '0')}${random}`;
}

/**
 * How many submissions' wire ids to remember. One `Map` entry per queued
 * message, so a long-lived tab must not keep them all. Past the window the
 * oldest submission re-mints on its next dispatch — i.e. it degrades to exactly
 * the per-call behaviour, never to a wrong id — and 256 entries is far more than
 * the 60s the proxy's dedupe actually spans.
 */
const MAX_REMEMBERED_SUBMISSIONS = 256;
const submissionWireIds = new Map<string, string>();

/**
 * The wire `messageID` for ONE submission: minted on first dispatch, then reused
 * for every later dispatch of the same `clientMessageId` in the same session.
 *
 * Keyed by session as well as by the caller's id because a host mints queue keys
 * per session store, not globally, and an id has to sort against ITS session's
 * transcript — `mintPromptMessageId` reads that transcript to place it.
 */
function submissionWireId(sessionId: string, clientMessageId: string | undefined): string {
  if (!clientMessageId) return mintPromptMessageId(sessionId);
  const key = `${sessionId} ${clientMessageId}`;
  const known = submissionWireIds.get(key);
  if (known) return known;
  const minted = mintPromptMessageId(sessionId);
  submissionWireIds.set(key, minted);
  // `Map` iterates in insertion order, so the first key is the oldest.
  while (submissionWireIds.size > MAX_REMEMBERED_SUBMISSIONS) {
    const oldest = submissionWireIds.keys().next().value;
    if (oldest === undefined) break;
    submissionWireIds.delete(oldest);
  }
  return minted;
}

export interface SendOpenCodeMessageArgs {
  sessionId: string;
  parts: PromptPart[];
  options?: SendMessageOptions;
  /**
   * Identity of THIS submission on the wire. Omit it and one is minted per
   * call — which is what keeps two identical prompts from hashing to a single
   * proxy delivery. Pass one only to re-send a submission you already made and
   * want the proxy to recognise as the same delivery.
   *
   * Prefer `clientMessageId` unless you are already holding a wire-format id:
   * this one is used verbatim, so a badly-shaped id (see `ascendingId`) sorts
   * below the server's and makes opencode read the prompt as already answered.
   */
  messageID?: string;
  /**
   * Stable name for the SUBMISSION this call dispatches — the host's own key,
   * e.g. `QueuedMessageInput.clientMessageId`. Two calls carrying the same one
   * are the same submission and send the same wire `messageID`, so the proxy's
   * body-hash dedupe still absorbs a host-level retry. Two different ones are
   * two submissions and always differ, so a deliberate identical re-send is
   * never swallowed.
   *
   * Any string works — this is an identity, not a format. The wire id is minted
   * here from it.
   */
  clientMessageId?: string;
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
  clientMessageId,
}: SendOpenCodeMessageArgs): Promise<void> {
  const mappedParts = parts.map((p) => {
    if (p.type === 'file') return { type: 'file' as const, mime: p.mime, url: p.url, filename: p.filename, source: p.source };
    if (p.type === 'agent') return { type: 'agent' as const, name: p.name, source: p.source };
    return { type: 'text' as const, text: p.text };
  });
  // Resolved ONCE, here, outside the retry loop below — every attempt of this
  // submission re-sends the same id, so the proxy's dedupe still short-circuits
  // a genuine retry, while the NEXT submission gets a fresh id and can never be
  // mistaken for this one. `clientMessageId` extends "this submission" past the
  // loop to the host's own retry of the same queue entry; without it a fresh
  // call always means a fresh id.
  const promptMessageId = messageID ?? submissionWireId(sessionId, clientMessageId);
  const payload = {
    sessionID: sessionId,
    parts: mappedParts,
    messageID: promptMessageId,
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
      const result = await client.session.promptAsync(payload);
      if (!result?.error) return; // 204 — server accepted the prompt.
      error = result.error;
      status = (result.response as Response | undefined)?.status;
    } catch (err) {
      error = err; // thrown = transport failure (no status) OR getClient() not-ready.
    }

    const delay = getSendRetryDelayMs(attempt, status, error);
    if (delay === null) {
      const err =
        error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
      const errData =
        err?.data && typeof err.data === 'object' ? (err.data as Record<string, unknown>) : undefined;
      const message = errData?.message || err?.message || 'Failed to send message';
      const wrapped = new Error(
        typeof message === 'string' ? message : 'Failed to send message',
      ) as SendOpenCodeMessageError;
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
  return useMutation({
    mutationFn: promptOpenCodeMessage,
    // Same rationale as `useExecuteOpenCodeCommand`: this POSTs `prompt_async`,
    // which CREATES a user message. Retrying it sends the prompt twice.
    //
    // It is stated here rather than left to the host because a host default
    // cannot know that. apps/web's is
    // `error?.status >= 400 && error?.status < 500 ? false : failureCount < 1`,
    // which reads like "don't retry client errors" but lets every 5xx through —
    // and a 502 from the sandbox proxy is exactly the case where opencode may
    // already hold the message. The proxy's content-hash dedupe has been
    // absorbing that, which is the same "one layer relying on another's guard"
    // shape that let a `/command` execute four times.
    //
    // `promptOpenCodeMessage` already runs its own bounded boot-window retry
    // for the states that ARE safe to repeat (`opencode not ready`, sandbox
    // still waking), so nothing is lost by switching the outer one off.
    retry: false,
  });
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
        const statuses = statusResult.data;
        const serverStatus = statuses?.[sessionId];
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
