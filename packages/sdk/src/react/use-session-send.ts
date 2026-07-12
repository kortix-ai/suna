'use client';

/**
 * useSessionSend — the reusable send / stash-replay / error-recovery core
 * extracted from apps/web's `session-chat.tsx`. That file used to duplicate
 * the same "optimistic message → send → recover on failure" sequence in TWO
 * places: the new-session stash-replay effect and the composer's
 * `handleSend`. Both paths:
 *
 *   1. Add an optimistic user message to the sync store + flip the session
 *      busy (`beginOptimisticSend`).
 *   2. Send via `promptOpenCodeMessage` (which already owns network retry —
 *      this module never re-wraps that).
 *   3. On failure, classify the error, drop busy, and either keep the
 *      optimistic message and rehydrate real messages from the server (some
 *      error paths — e.g. a missing API key — return the error directly in
 *      the HTTP response without ever emitting a `session.error` SSE event,
 *      so nothing else would ever bring the real messages in) or drop the
 *      optimistic message outright when the send never reached the network
 *      at all (`recoverFromSendFailure` vs. `abandonOptimisticSend`).
 *
 * This module holds ONE implementation of each of those mechanics:
 *  - Pure, directly-testable functions for the bookkeeping + recovery
 *    (`beginOptimisticSend`, `abandonOptimisticSend`, `recoverFromSendFailure`,
 *    `sendAndRecover`, `applyOptimisticAbort`).
 *  - A framework-free `replayStartStash` orchestrator for the write-race
 *    retry + readiness poll + failure stash-restore that used to be a ~180
 *    line inline effect. It takes the host's model/agent readiness check and
 *    parts-building as injected callbacks — it never hardcodes a model store.
 *  - A convenience `useSessionSend(sessionId, opts)` hook for a host that just
 *    wants "send this text" (mirrors `useSession`'s `send`/`sendError`
 *    ergonomics) — for a host with bespoke pre-send steps (mentions, file
 *    uploads, per-session model/agent resolution — e.g. apps/web), call the
 *    pure functions directly instead, as apps/web's `session-chat.tsx` does.
 */

import type { Message, Part } from '../runtime/wire-types';
import { useCallback, useState } from 'react';
import { getClient } from '../opencode/client';
import { ascendingId, useSyncStore } from '../state/sync-store';
import type { MessageError } from '../state/sync-store/types';
import { classifySendError, type KortixSendError } from './use-session';
import {
  promptOpenCodeMessage,
  useAbortOpenCodeSession,
  type PromptPart,
  type SendMessageOptions,
} from './use-opencode-sessions';
import { readStartStash, writeStartStash, type StartStash } from './session-start-stash';

// ============================================================================
// Optimistic-send bookkeeping — pure sync-store mechanics, shared by every
// send path.
// ============================================================================

/**
 * Add a user message to the sync store optimistically (before the server has
 * accepted it) and flip the session busy. Both actions are independent
 * zustand writes (neither depends on the other's result), so callers that
 * used to fire them in the opposite order see no observable difference.
 */
export function beginOptimisticSend(
  sessionId: string,
  messageId: string,
  text: string,
  partIds?: string[],
): void {
  const parts: Part[] = text.trim()
    ? [
        {
          id: partIds?.[0] ?? ascendingId('prt'),
          sessionID: sessionId,
          messageID: messageId,
          type: 'text' as const,
          text,
        },
      ]
    : [];
  // Minimal optimistic stub — omits `agent`/`model` (required on the real
  // `UserMessage`) since the server fills those in; same stub-message
  // convention used by the sync store's own SSE handlers.
  const info = {
    id: messageId,
    sessionID: sessionId,
    role: 'user',
    time: { created: Date.now() },
  } as Message;
  useSyncStore.getState().optimisticAdd(sessionId, info, parts);
  useSyncStore.getState().setStatus(sessionId, { type: 'busy' });
}

/**
 * A send that never reached the network at all (e.g. building the outgoing
 * parts — file uploads — threw before `promptOpenCodeMessage` was even
 * called). There is nothing to rehydrate from the server since it never saw
 * this message, so just clear busy and drop the optimistic message outright
 * — unlike `recoverFromSendFailure`, which keeps it pending a rehydrate.
 */
export function abandonOptimisticSend(sessionId: string, messageId: string): void {
  useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
  useSyncStore.getState().optimisticRemove(sessionId, messageId);
}

// ============================================================================
// Failure recovery — the ONE implementation of what used to be apps/web's
// duplicated `handleSendError`/`handlePromptError`.
// ============================================================================

/** The minimal slice of `OpencodeClient` the recovery rehydrate needs. */
export interface OpenCodeMessagesClient {
  session: {
    messages: (args: { sessionID: string }) => Promise<{ data?: unknown }>;
  };
}

/** Shape `useSyncStore.getState().hydrate()` actually needs. `data` on
 *  `OpenCodeMessagesClient['session']['messages']` is deliberately `unknown`
 *  (hosts inject their own stub client in tests) — narrow at the one real
 *  call site below instead of widening that public interface. */
type HydrateInput = Array<{ info: Message; parts: Part[] }>;

export interface SendRecoveryOptions {
  /** Resolve the client used to rehydrate messages on failure. Defaults to
   * the SDK's `getClient` — inject a stub in tests, or a different client in
   * a host that doesn't use the singleton runtime client. */
  getClient?: () => OpenCodeMessagesClient;
  /** Classify the raw error into a `KortixSendError`. Defaults to
   * `classifySendError` — a host with richer message formatting (e.g.
   * apps/web's `ProviderModelNotFoundError` special-casing) injects its own
   * classifier that wraps it. */
  classify?: (error: unknown) => KortixSendError;
}

/**
 * A send reached the network and failed (or the network dispatch itself
 * threw). Classify the error, clear busy, and either rehydrate real messages
 * from the server (keeping the optimistic message visible until then — some
 * error paths never emit a `session.error` SSE event) or drop the optimistic
 * message if the server has no record of it. The rehydrate is fire-and-forget
 * (matches the original inline `.then()/.catch()` — callers don't await it),
 * so this function itself resolves synchronously with the classified error.
 */
export function recoverFromSendFailure(
  sessionId: string,
  messageId: string,
  error: unknown,
  options: SendRecoveryOptions = {},
): KortixSendError {
  const classify = options.classify ?? classifySendError;
  const resolveClient = options.getClient ?? (getClient as unknown as () => OpenCodeMessagesClient);
  const classified = classify(error);

  useSyncStore.getState().setStatus(sessionId, { type: 'idle' });

  let client: OpenCodeMessagesClient;
  try {
    client = resolveClient();
  } catch {
    useSyncStore.getState().optimisticRemove(sessionId, messageId);
    return classified;
  }

  client.session
    .messages({ sessionID: sessionId })
    .then((res) => {
      if (res?.data) {
        // hydrate() already drops superseded optimistic messages AND bridges
        // their text onto the real server message. Do NOT also call
        // clearOptimisticMessages here: on an error send whose user message
        // the server hasn't persisted yet, that wipes the user's typed text
        // and leaves an empty bubble. Keeping the optimistic message means
        // the user always still sees what they sent.
        useSyncStore.getState().hydrate(sessionId, res.data as HydrateInput);
      } else {
        // No server data — just remove the optimistic message.
        useSyncStore.getState().optimisticRemove(sessionId, messageId);
      }
    })
    .catch(() => {
      // Fetch failed — fall back to removing the optimistic message.
      useSyncStore.getState().optimisticRemove(sessionId, messageId);
    });

  return classified;
}

export interface SendAndRecoverArgs {
  sessionId: string;
  /** The optimistic message id to keep-or-drop on failure. */
  messageId: string;
  parts: PromptPart[];
  options?: SendMessageOptions;
  getClient?: () => OpenCodeMessagesClient;
  classify?: (error: unknown) => KortixSendError;
}

export type SendAndRecoverResult =
  | { ok: true }
  | { ok: false; error: KortixSendError; cause: unknown };

/**
 * Send already-built parts via `promptOpenCodeMessage` (which owns network
 * retry — this never re-wraps it) and run `recoverFromSendFailure` on
 * failure. Assumes the optimistic message was already added by the caller
 * (via `beginOptimisticSend`) — callers add it at different points relative
 * to building `parts` (e.g. before vs. after an upload step that can itself
 * fail), so this only owns the network call + failure recovery.
 */
export async function sendAndRecover(args: SendAndRecoverArgs): Promise<SendAndRecoverResult> {
  try {
    await promptOpenCodeMessage({
      sessionId: args.sessionId,
      parts: args.parts,
      options: args.options,
    });
    return { ok: true };
  } catch (cause) {
    const error = recoverFromSendFailure(args.sessionId, args.messageId, cause, {
      getClient: args.getClient,
      classify: args.classify,
    });
    return { ok: false, error, cause };
  }
}

// ============================================================================
// Optimistic abort patch — the generic half of apps/web's `handleStop`. Pure
// sync-store manipulation (no web-specific concepts), so it's extracted; the
// abort mutation itself stays a shared per-host instance (apps/web fans it
// out to multiple call sites beyond stop, so `useSessionSend` deliberately
// does NOT own a second competing `useAbortOpenCodeSession()` instance for
// hosts that already have one — see `useSessionSend.stop` below for a host
// that doesn't).
// ============================================================================

/**
 * Optimistically mark the session idle and patch an "aborted" error onto the
 * last assistant message that doesn't already have one, so an "Interrupted"
 * label can render instantly instead of waiting for the SSE `session.error`
 * round-trip. Call this immediately before issuing the actual abort request.
 */
export function applyOptimisticAbort(sessionId: string): void {
  useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
  const store = useSyncStore.getState();
  const msgs = store.messages[sessionId];
  if (!msgs) return;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.role === 'assistant' && !msg.error) {
      // Typed as the wider `MessageError` (not just the literal shape below)
      // so the assertion further down overlaps with `AssistantMessage.error`'s
      // real union — see `MessageError` in the sync store.
      const error: MessageError = {
        name: 'AbortError',
        data: { message: 'The operation was aborted.' },
      };
      // `error`'s shape (`SyntheticAbortError`) isn't part of the SDK's
      // `AssistantMessage.error` union — see `MessageError` in the sync
      // store. TS flags the direct assertion as an insufficient-overlap
      // mistake because it narrows the literal's `error` field back down to
      // `SyntheticAbortError`; route through `unknown` as TS itself suggests.
      const patched = { ...msg, error } as unknown as Message;
      store.upsertMessage(sessionId, patched);
      break;
    }
  }
}

// ============================================================================
// Stash-replay orchestration — framework-free write-race retry + readiness
// poll + failure stash-restore, extracted from apps/web's new-session
// hand-off effect (same pattern as `state/event-stream.ts`'s framework-free
// SSE machine: an injectable timer seam so tests can drive it deterministically).
// ============================================================================

/** A timer handle — opaque, only ever round-tripped through the injected timers. */
export type StashReplayTimerHandle = unknown;

/** Injectable timer seam — defaults to the real globals. Lets tests drive the
 * write-race/readiness-poll timing deterministically instead of depending on
 * real wall-clock delays. */
export interface StashReplayTimers {
  setTimeout: (handler: () => void, ms: number) => StashReplayTimerHandle;
  clearTimeout: (handle: StashReplayTimerHandle | undefined) => void;
}

const realStashReplayTimers: StashReplayTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout> | undefined),
};

export interface PreparedStashSend {
  /** The optimistic message id to add + keep-or-drop on failure. */
  messageId: string;
  /** Optimistic text to render immediately (may include e.g. upload markup —
   * distinct from the actual outgoing parts, which `buildParts` builds). */
  optimisticText: string;
  partIds?: string[];
  sendOptions?: SendMessageOptions;
  /** Build the parts to actually send over the wire (e.g. after uploading
   * attached files). Thrown failures are treated exactly like a network-send
   * failure (stash restored, `onFailure` invoked with the classified error). */
  buildParts: () => Promise<PromptPart[]>;
}

export interface StartStashReplayOptions<TReady> {
  sessionId: string;
  /** Defaults to the SDK's `readStartStash`; overridable for tests. */
  readStash?: (sessionId: string) => StartStash | null;
  /** How many `writeRaceIntervalMs`-spaced attempts to retry reading the
   * stash before giving up — handles the write race where this can run
   * before the producer (the "new session" screen) has written it. Default 5. */
  writeRaceAttempts?: number;
  /** Default 50ms. */
  writeRaceIntervalMs?: number;
  /**
   * Poll for readiness (e.g. a selectable model) before sending. Return the
   * resolved value once ready, or `null` to keep polling. Called with the
   * stash on every attempt so a host can seed its own agent/model stores
   * from it as a side effect (matching the original inline behavior) —
   * deliberately host-owned so this module never hardcodes a model store.
   */
  checkReadiness: (stash: StartStash) => TReady | null;
  /** Default 120. */
  readinessAttempts?: number;
  /** Default 250ms. */
  readinessIntervalMs?: number;
  /** The readiness poll never resolved within `readinessAttempts`. */
  onReadinessTimeout?: (stash: StartStash) => void;
  /** Called once ready — build the optimistic message + parts to send. */
  prepare: (stash: StartStash, ready: TReady) => PreparedStashSend;
  /**
   * Called on ANY send failure (building parts OR the network call). By the
   * time this fires, the stash has already been restored (`writeStartStash`)
   * and the optimistic message already recovered (idle + rehydrate-or-remove,
   * via `recoverFromSendFailure`) — use this for host-specific extras (e.g.
   * restoring pending file uploads, resetting an "already handled" flag,
   * surfacing the classified error).
   */
  onFailure?: (stash: StartStash, error: unknown, classified: KortixSendError) => void;
  getClient?: () => OpenCodeMessagesClient;
  classify?: (error: unknown) => KortixSendError;
  timers?: StashReplayTimers;
}

export interface StartStashReplayHandle {
  /** Stop all pending retries/polls and abandon any in-flight send's failure
   * handling. Idempotent. */
  cancel: () => void;
}

/**
 * Read a stashed new-session prompt (retrying across the producer's write
 * race), poll for host-defined send readiness, then send it — restoring the
 * stash (+ recovering the optimistic message) on any failure. Framework-free:
 * safe to call from a `useEffect` (as apps/web's `session-chat.tsx` does) or
 * any other host.
 */
export function replayStartStash<TReady>(
  options: StartStashReplayOptions<TReady>,
): StartStashReplayHandle {
  const {
    sessionId,
    readStash = readStartStash,
    writeRaceAttempts = 5,
    writeRaceIntervalMs = 50,
    checkReadiness,
    readinessAttempts = 120,
    readinessIntervalMs = 250,
    onReadinessTimeout,
    prepare,
    onFailure,
    getClient: getClientOpt,
    classify,
  } = options;
  const t = options.timers ?? realStashReplayTimers;
  let cancelled = false;
  let timer: StashReplayTimerHandle;

  const fail = (stash: StartStash, messageId: string, error: unknown) => {
    writeStartStash(sessionId, stash);
    const classified = recoverFromSendFailure(sessionId, messageId, error, {
      getClient: getClientOpt,
      classify,
    });
    onFailure?.(stash, error, classified);
  };

  const attemptSend = (stash: StartStash, ready: TReady) => {
    const prepared = prepare(stash, ready);
    beginOptimisticSend(sessionId, prepared.messageId, prepared.optimisticText, prepared.partIds);
    void (async () => {
      let parts: PromptPart[];
      try {
        parts = await prepared.buildParts();
      } catch (err) {
        // Unconditional — matches the original inline effect, which recovered
        // this failure even if `cancel()` had already fired (only the
        // network-send catch below was guarded there).
        fail(stash, prepared.messageId, err);
        return;
      }
      try {
        await promptOpenCodeMessage({ sessionId, parts, options: prepared.sendOptions });
      } catch (err) {
        if (!cancelled) fail(stash, prepared.messageId, err);
      }
    })();
  };

  const pollReadiness = (stash: StartStash, attempt: number) => {
    if (cancelled) return;
    const ready = checkReadiness(stash);
    if (ready !== null) {
      attemptSend(stash, ready);
      return;
    }
    if (attempt < readinessAttempts) {
      timer = t.setTimeout(() => pollReadiness(stash, attempt + 1), readinessIntervalMs);
      return;
    }
    onReadinessTimeout?.(stash);
  };

  const readWithRetry = (attempt: number) => {
    if (cancelled) return;
    const stash = readStash(sessionId);
    if (!stash?.prompt) {
      if (attempt < writeRaceAttempts) {
        timer = t.setTimeout(() => readWithRetry(attempt + 1), writeRaceIntervalMs);
        return;
      }
      return;
    }
    // Carry the attempt count forward into the readiness poll (matches the
    // original inline effect, which used one shared counter across both
    // loops) rather than resetting to 0 — the write-race retry only ever
    // consumes a handful of attempts before finding the stash, so this only
    // trims the readiness budget by that same handful, never resets it.
    pollReadiness(stash, attempt);
  };

  readWithRetry(0);

  return {
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) t.clearTimeout(timer);
    },
  };
}

// ============================================================================
// useSessionSend — convenience hook for a host that just wants "send this
// text" (mirrors `useSession`'s `send`/`sendError` ergonomics). A host with
// bespoke pre-send steps (mentions, file uploads, per-session model/agent
// resolution — e.g. apps/web's `session-chat.tsx`) calls the pure functions
// above directly instead.
// ============================================================================

export interface UseSessionSendOptions {
  getClient?: () => OpenCodeMessagesClient;
  classify?: (error: unknown) => KortixSendError;
}

export interface SendCallOptions {
  /** Optimistic message id. Auto-generated (via the sync store's ascending
   * id scheme) if omitted. */
  messageId?: string;
  /** Text to show optimistically before the server echoes it back. Defaults
   * to the first text part's `text`. */
  optimisticText?: string;
  /** Part ids to reuse for the optimistic message (so the server's echo
   * updates the same part instead of duplicating it). */
  partIds?: string[];
}

export interface UseSessionSendResult {
  send: (
    parts: PromptPart[],
    options?: SendMessageOptions,
    callOptions?: SendCallOptions,
  ) => Promise<SendAndRecoverResult>;
  /** Abort the run and optimistically patch the last assistant message +
   * session status (see `applyOptimisticAbort`). No-ops while a previous
   * abort is still in flight. */
  stop: () => void;
  isSending: boolean;
  isStopping: boolean;
  /** Last `send` failure, or null. Reset on every new `send` call. */
  sendError: KortixSendError | null;
}

export function useSessionSend(
  sessionId: string,
  options: UseSessionSendOptions = {},
): UseSessionSendResult {
  const { getClient: getClientOpt, classify } = options;
  const [sendError, setSendError] = useState<KortixSendError | null>(null);
  const [isSending, setIsSending] = useState(false);
  const abortMutation = useAbortOpenCodeSession();

  const send = useCallback(
    async (
      parts: PromptPart[],
      sendOptions?: SendMessageOptions,
      callOptions: SendCallOptions = {},
    ): Promise<SendAndRecoverResult> => {
      setSendError(null);
      const messageId = callOptions.messageId ?? ascendingId('msg');
      const firstText = parts.find((p): p is Extract<PromptPart, { type: 'text' }> => p.type === 'text');
      const optimisticText = callOptions.optimisticText ?? firstText?.text ?? '';
      beginOptimisticSend(sessionId, messageId, optimisticText, callOptions.partIds);
      setIsSending(true);
      const result = await sendAndRecover({
        sessionId,
        messageId,
        parts,
        options: sendOptions,
        getClient: getClientOpt,
        classify,
      });
      setIsSending(false);
      if (!result.ok) setSendError(result.error);
      return result;
    },
    [sessionId, getClientOpt, classify],
  );

  const stop = useCallback(() => {
    if (!sessionId || abortMutation.isPending) return;
    applyOptimisticAbort(sessionId);
    abortMutation.mutate(sessionId);
  }, [sessionId, abortMutation]);

  return { send, stop, isSending, isStopping: abortMutation.isPending, sendError };
}
