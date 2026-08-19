'use client';

/**
 * useSessionSend — the reusable send / stash-replay / error-recovery core
 * extracted from apps/web's `session-chat.tsx`. That file used to duplicate
 * the same "optimistic message → send → recover on failure" sequence in TWO
 * places: the new-session stash-replay effect and the composer's
 * `handleSend`. Both paths:
 *
 *   1. Add an optimistic user message to the sync store (`beginOptimisticSend`).
 *   2. Send via `promptOpenCodeMessage` (which already owns network retry —
 *      this module never re-wraps that).
 *   3. On failure, classify the error, release the send receipt, and either keep the
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
 *    `sendAndRecover`, `applyOptimisticAbort`, `sendWithReceipt`,
 *    `stopWithReceipt`).
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

import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { useCallback, useState } from 'react';
import { getClient } from '../core/runtime/client';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { SESSION_SYNC_PAGE_SIZE } from '../core/session-sync/session-sync-controller';
import { holdSessionPrompts } from '../core/rest/projects-client';
import { ascendingId, useSyncStore } from '../browser/stores/sync-store';
import type { MessageError } from '../browser/stores/sync-store/types';
import { classifySendError, type KortixSendError } from './use-session';
import {
  abortInFlightDeliveries,
  awaitAbortSettlement,
  promptOpenCodeMessage,
  useAbortOpenCodeSession,
  type AbortSettlement,
  type PromptPart,
  type SendMessageOptions,
} from './use-opencode-sessions';
import { readStartStash, writeStartStash, type StartStash } from './session-start-stash';

// ============================================================================
// Optimistic-send bookkeeping — pure sync-store mechanics, shared by every
// send path.
// ============================================================================

/**
 * Add a user message to the sync store optimistically — before the server has
 * accepted it — and nothing else.
 *
 * It used to also write `{type:'busy'}` into `sessionStatus`, the slot the
 * runtime's own SSE frames land in. A fabricated frame there is
 * indistinguishable from one the daemon sent, and it outranked a real
 * `GET .../turn` read stamped after it. "Is this session working?" is answered
 * once, by `projectWorking`, and this tab's own claim on it is the
 * `SendReceipt` (`session-working-store.ts`) — not a status write. This
 * function paints the bubble; the receipt owns the working state.
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
}

/**
 * The prompt has gone out — the optimistic message is no longer `pending`.
 *
 * Call this immediately before POSTing, for any host that pairs
 * `beginOptimisticSend` with its own hand-rolled send. Until it is called the
 * sync store treats the message as never having been shown to the server, so
 * nothing the server echoes back is allowed to supersede it — and the user
 * sees their own message twice for the entire turn, until the session goes
 * idle and `clearOptimisticMessages` finally sweeps it.
 *
 * `useSession.sendParts` marks dispatch by correlating the client-generated
 * part ids that ride along with the prompt. A host that deliberately strips
 * those ids (because client ids can sort before server ids under clock skew)
 * has nothing to correlate on, and needs to say so explicitly. This is that
 * explicit path.
 *
 * Never call it on a host's behalf, and never before the POST: a message the
 * server has not been told about cannot be a copy of anything it returns, and
 * pairing them would delete text the user typed.
 */
export function markOptimisticSendDispatched(sessionId: string, messageId: string): void {
  useSyncStore.getState().markOptimisticDispatched(sessionId, messageId);
}

/**
 * The prompt is going to the durable inbox (`POST .../prompts`): from here the
 * host's own send path owns the bubble's life — the POST's failure path
 * removes it explicitly, the runtime's echo confirms it in place (same id) or
 * supersedes it (re-minted id, aliased by the store) — and the local idle
 * sweep must leave it alone. Call it next to `markOptimisticSendDispatched`,
 * BEFORE the POST: the enqueue promise settles after its cache work, and a
 * session that goes idle or aborts in that window (a Stop, an asleep box) is
 * not evidence the prompt was lost. Only for a host that painted the bubble
 * with the WIRE id it hands the inbox.
 */
export function markOptimisticSendInboxBacked(sessionId: string, messageId: string): void {
  useSyncStore.getState().markOptimisticInboxBacked(sessionId, messageId);
}

/**
 * A send that never reached the network at all (e.g. building the outgoing
 * parts — file uploads — threw before `promptOpenCodeMessage` was even
 * called). There is nothing to rehydrate from the server since it never saw
 * this message, so drop the optimistic message outright — unlike
 * `recoverFromSendFailure`, which keeps it pending a rehydrate.
 *
 * It releases the send RECEIPT, not the session status. "Nothing is coming for
 * this send" is what this path knows; "the session is idle" is not, and writing
 * it into the status slot unmasked live turns (a trigger, a second device).
 * NAMED, so a slow abandon cannot drop a later send's receipt.
 */
export function abandonOptimisticSend(sessionId: string, messageId: string): void {
  useSessionWorkingStore.getState().clearSendReceipt(sessionId, messageId);
  useSyncStore.getState().optimisticRemove(sessionId, messageId);
}

// ============================================================================
// Failure recovery — the ONE implementation of what used to be apps/web's
// duplicated `handleSendError`/`handlePromptError`.
// ============================================================================

/** The minimal slice of `OpencodeClient` the recovery rehydrate needs. */
export interface OpenCodeMessagesClient {
  session: {
    messages: (args: { sessionID: string; limit?: number }) => Promise<{ data?: unknown }>;
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
 * threw). Classify the error, release this send's receipt, and either
 * rehydrate real messages from the server (keeping the optimistic message
 * visible until then — some error paths never emit a `session.error` SSE
 * event) or drop the optimistic message if the server has no record of it. The
 * rehydrate is fire-and-forget (matches the original inline `.then()/.catch()`
 * — callers don't await it), so this function itself resolves synchronously
 * with the classified error.
 *
 * It writes NO status. An HTTP send failure is not evidence that the session is
 * idle: a trigger, a second device, or a POST the control plane already
 * accepted can all be running, and this was the worst of the fabricated writes
 * — it unmasked a live turn by declaring idle into the slot the projection
 * reads as runtime truth.
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

  // NAMED: a slow failure must not drop the receipt of a send submitted after
  // it whose POST is still on the wire. See `clearSendReceipt`.
  useSessionWorkingStore.getState().clearSendReceipt(sessionId, messageId);

  let client: OpenCodeMessagesClient;
  try {
    client = resolveClient();
  } catch {
    useSyncStore.getState().optimisticRemove(sessionId, messageId);
    return classified;
  }

  client.session
    .messages({ sessionID: sessionId, limit: SESSION_SYNC_PAGE_SIZE })
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
  /**
   * Stable name for the submission, so re-dispatching a failed send keeps one
   * wire `messageID` and the proxy's duplicate protection still absorbs it.
   * Distinct from `messageId` above, which is the LOCAL optimistic message and
   * never goes on the wire. See `SendOpenCodeMessageArgs.clientMessageId`.
   */
  clientMessageId?: string;
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
    // The message is now the server's problem too. Until this point it was
    // `pending`, and `hydrate` refuses to let a pending message be superseded
    // by an ordinal match — see `markOptimisticDispatched`.
    useSyncStore.getState().markOptimisticDispatched(args.sessionId, args.messageId);
    await promptOpenCodeMessage({
      sessionId: args.sessionId,
      parts: args.parts,
      options: args.options,
      ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
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
 * Patch an "aborted" error onto the last assistant message that doesn't
 * already have one, so an "Interrupted" label can render instantly instead of
 * waiting for the SSE `session.error` round-trip. Call this immediately
 * before issuing the actual abort request.
 *
 * This deliberately writes NO status frame. It used to fabricate an idle
 * frame here, and `projectWorking` cannot tell a fabricated frame from a real
 * one — the fabrication outranked the control plane's own `/turn` answer for
 * the whole abort round-trip. The same intent now travels as an
 * `AbortReceipt` (`noteAbortReceipt`), which carries provenance and a bound
 * (`OPTIMISTIC_ABORT_MAX_MS`). The transcript-side patch below stays: it is a
 * designed optimistic echo about a MESSAGE, not a status.
 */
export function applyOptimisticAbort(sessionId: string): void {
  const store = useSyncStore.getState();
  const msgs = store.messages[sessionId];
  if (!msgs) return;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.role === 'assistant' && !msg.error) {
      // Typed as the wider `MessageError` (not just the literal shape below)
      // so the assertion further down overlaps with `AssistantMessage.error`'s
      // real union — see `MessageError` in the sync store.
      // `reason: 'user'` — a REAL user stop, as opposed to
      // `markSessionAbortedLocally`'s `'runtime-disposed'`. Read via the
      // SDK's `abortErrorReason` (`core/http/abort-error.ts`); apps/web
      // renders this reason as the "Interrupted" checkpoint row.
      const error: MessageError = {
        name: 'AbortError',
        data: { message: 'The operation was aborted.', reason: 'user' },
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
  /** Called after the runtime acknowledges the prompt. */
  onSuccess?: (stash: StartStash) => void;
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
    onSuccess,
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
        useSyncStore.getState().markOptimisticDispatched(sessionId, prepared.messageId);
        await promptOpenCodeMessage({ sessionId, parts, options: prepared.sendOptions });
        if (!cancelled) onSuccess?.(stash);
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
// Receipts — what this tab has outstanding, and the floors they put under a
// server read. These are plain functions, not hook bodies, so the ORDER is
// asserted by a test rather than inspected by eye.
// ============================================================================

export interface SendWithReceiptArgs extends SendAndRecoverArgs {
  /**
   * The KORTIX session id, when it differs from `sessionId`.
   *
   * Two ids, deliberately: `sessionId` addresses the OpenCode runtime the
   * prompt is POSTed to, while `useSessionWorking` — and therefore the receipt
   * store — is keyed by the Kortix session `GET .../turn` answers about.
   * Filing under the wrong one is filing under nothing. Defaults to
   * `sessionId` for a host where the two coincide.
   */
  workingSessionId?: string;
}

/**
 * Send, with this tab's own receipt filed around it.
 *
 * The receipt is what stops a `GET .../turn` read issued while the POST is
 * still on the wire — which honestly answers "no turns", because there is
 * nothing for it to see yet — from flipping the composer back to Send in the
 * middle of the send. It is noted BEFORE the request and accepted only once
 * the server has durably taken the prompt; a refused send releases it (via
 * `recoverFromSendFailure`, by name) so a send that will never run cannot
 * claim `working` for a minute. See `SendReceipt`.
 */
export async function sendWithReceipt(args: SendWithReceiptArgs): Promise<SendAndRecoverResult> {
  const workingSessionId = args.workingSessionId ?? args.sessionId;
  useSessionWorkingStore
    .getState()
    .noteSendReceipt(workingSessionId, { messageId: args.messageId, atMs: Date.now() });
  const result = await sendAndRecover(args);
  if (result.ok) {
    // The server has the prompt. From here — and NOT before — a `/turn` read
    // is able to see it, so one is allowed to answer for it.
    useSessionWorkingStore
      .getState()
      .acceptSendReceipt(workingSessionId, args.messageId, Date.now());
  } else {
    // The prompt never reached the server, so there is nothing to wait for.
    // `recoverFromSendFailure` already released it under `args.sessionId`;
    // repeat it under the working id for a host whose two ids differ. NAMED,
    // so a slow failure cannot drop a later send's receipt.
    useSessionWorkingStore.getState().clearSendReceipt(workingSessionId, args.messageId);
  }
  return result;
}

/**
 * How long `stopWithReceipt` waits for the server-side prompt-inbox hold
 * (below) before issuing the abort anyway. Mirrors apps/web's
 * `STOP_HOLD_DEADLINE_MS` (`session-chat.tsx`) — kept as the same value for
 * the same reason: the hold call carries no client timeout of its own, and a
 * stalled socket must not delay the abort by more than a bounded amount.
 */
export const STOP_HOLD_DEADLINE_MS = 1_500;

export interface StopWithReceiptOptions {
  workingSessionId?: string;
  /**
   * Kortix project id. Required to hold the session's server-side prompt
   * inbox before the abort goes out (see below). Omit only for a host with
   * no prompt inbox for this session — the hold is skipped entirely, matching
   * this function's behavior before the inbox existed.
   */
  projectId?: string;
  /**
   * Kortix session id whose inbox to hold. The inbox is keyed by the same
   * Kortix session `GET .../turn` answers about, so this defaults to
   * `workingSessionId` (or `sessionId`), never to the OpenCode runtime id.
   */
  inboxSessionId?: string;
  /** Injectable, defaults to `holdSessionPrompts`. Lets a host or a test
   * substitute its own inbox client. */
  holdInboxPrompts?: (projectId: string, sessionId: string, held: boolean) => Promise<unknown>;
  /** Default {@link STOP_HOLD_DEADLINE_MS}. */
  holdDeadlineMs?: number;
}

/**
 * Stop, with this tab's own abort receipt filed around it.
 *
 * The mirror of `sendWithReceipt`, for the mirror-image failure: the cancel
 * needs a round trip through the control plane and the daemon (~1.6s measured)
 * before turn authority is released, so every `/turn` read issued inside that
 * window still reports the doomed turn — including the one the optimistic idle
 * frame itself triggers. Without the receipt the composer swapped Send back to
 * Stop about 120ms after the click and stayed there for the whole abort. See
 * `AbortReceipt`.
 *
 * It also holds the session's server-side prompt inbox BEFORE issuing the
 * abort, the same pairing apps/web's `handleStop` does by hand
 * (`session-chat.tsx`). A prompt sent mid-turn is forwarded into OpenCode's
 * live queue the moment it is admitted, so at stop time the inbox can hold a
 * row OpenCode already has. The abort drops OpenCode's in-memory queue; the
 * reaper then sees that row unanswered and redelivers it — due now — unless
 * the hold already marked it stop-paused. AWAITED (bounded by
 * `holdDeadlineMs`) so the ordering is a fact, not a race: without it, Stop
 * aborts the turn and is followed a beat later by exactly the message the
 * user pressed Stop to get ahead of. A failed hold is caught, never
 * rethrown — it must not cost the user their abort — and skipped entirely
 * when no `projectId` is given.
 *
 * `runAbort` is taken as a callback (normally `() =>
 * abortMutation.mutateAsync(sessionId)`) so the pairing is testable without
 * rendering a hook — the same shape `awaitAbortSettlement` already uses.
 */
export async function stopWithReceipt(
  sessionId: string,
  runAbort: () => Promise<void>,
  options: StopWithReceiptOptions = {},
): Promise<AbortSettlement> {
  const workingSessionId = options.workingSessionId ?? sessionId;
  const store = useSessionWorkingStore.getState();
  // Nothing is coming for ANY send once the user has pressed Stop — the one
  // place the unnamed clear is the correct one.
  store.clearSendReceipt(workingSessionId);
  store.noteAbortReceipt(workingSessionId, Date.now());
  applyOptimisticAbort(sessionId);
  // T9: stop a delivery still retrying its boot/wake backoff BEFORE the abort
  // request goes out, so it can never land after this point.
  abortInFlightDeliveries(sessionId);

  if (options.projectId) {
    const inboxSessionId = options.inboxSessionId ?? workingSessionId;
    const hold = options.holdInboxPrompts ?? holdSessionPrompts;
    const deadlineMs = options.holdDeadlineMs ?? STOP_HOLD_DEADLINE_MS;
    await Promise.race([
      hold(options.projectId, inboxSessionId, true).catch((error) => {
        // Caught, never rethrown — see the doc comment above.
        console.warn('[useSessionSend] failed to hold the prompt inbox on stop', error);
      }),
      new Promise((resolve) => setTimeout(resolve, deadlineMs)),
    ]);
  }

  const settlement = awaitAbortSettlement(runAbort);
  // `awaitAbortSettlement` never rejects — it resolves with how the abort ended
  // (acknowledged, failed, or timed out). Any of those is the instant from
  // which a server read can see the abort's effect, or fail to.
  void settlement.then(() =>
    useSessionWorkingStore.getState().settleAbortReceipt(workingSessionId, Date.now()),
  );
  return settlement;
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
  /**
   * The KORTIX session id, when it differs from the hook's `sessionId`.
   *
   * `sessionId` addresses the OpenCode runtime this hook POSTs to; the send and
   * abort receipts belong to the Kortix session `useSessionWorking` reads. Pass
   * it whenever the two ids differ, or the receipts are filed under a key
   * nothing reads. See `SendWithReceiptArgs.workingSessionId`.
   */
  workingSessionId?: string;
  /**
   * Kortix project id. Passed straight through to `stopWithReceipt` so
   * `stop()` holds the session's server-side prompt inbox before aborting —
   * see `StopWithReceiptOptions.projectId`. Omit for a host with no prompt
   * inbox for this session; `stop()` then aborts with no hold, exactly as it
   * did before the inbox existed.
   */
  projectId?: string;
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
   * session status (see `applyOptimisticAbort`), and stop any delivery still
   * retrying its own boot/wake backoff (T9 — `abortInFlightDeliveries`)
   * so a prompt in flight when Stop is hit can never land afterward. No-ops
   * (resolves `{ status: 'skipped' }`) while a previous abort is still in
   * flight, or when there is no session. Returns a promise that settles once
   * the abort is acknowledged — see `AbortSettlement`; a caller that never
   * awaits it sees exactly the same synchronous effects as before. */
  stop: () => Promise<AbortSettlement>;
  isSending: boolean;
  isStopping: boolean;
  /** Last `send` failure, or null. Reset on every new `send` call. */
  sendError: KortixSendError | null;
}

export function useSessionSend(
  sessionId: string,
  options: UseSessionSendOptions = {},
): UseSessionSendResult {
  const { getClient: getClientOpt, classify, workingSessionId, projectId } = options;
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
      const result = await sendWithReceipt({
        sessionId,
        ...(workingSessionId ? { workingSessionId } : {}),
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
    [sessionId, workingSessionId, getClientOpt, classify],
  );

  const stop = useCallback((): Promise<AbortSettlement> => {
    if (!sessionId || abortMutation.isPending) return Promise.resolve({ status: 'skipped' });
    return stopWithReceipt(sessionId, () => abortMutation.mutateAsync(sessionId), {
      ...(workingSessionId ? { workingSessionId } : {}),
      ...(projectId ? { projectId } : {}),
    });
  }, [sessionId, workingSessionId, projectId, abortMutation]);

  return { send, stop, isSending, isStopping: abortMutation.isPending, sendError };
}
