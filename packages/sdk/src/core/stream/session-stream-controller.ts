/**
 * The session-stream controller — ONE reconnecting reader over
 * `GET /projects/:pid/sessions/:sid/stream`, the Kortix Runtime API's
 * multiplexed SSE (runtime + control + stream channels).
 *
 * This is the transport that REPLACES the opencode-shaped `/p/<box>/8000/…`
 * event stream (`openEventStream` over `client.global.event()`): it talks to
 * the CONTROL PLANE, so it works while the box is stopped, waking, or dead,
 * and it carries the daemon's envelopes verbatim once the box attaches.
 *
 * Division of labour, stated once:
 *   - `readSessionStream` (session-stream.ts) owns the wire: one HTTP request,
 *     SSE parsing, typed frames. It deliberately owns NO reconnect policy.
 *   - THIS module owns the loop: reconnect with backoff, the heartbeat
 *     watchdog, cursor bookkeeping across attempts, and the typed resync/gap
 *     signals a store needs to refetch honestly.
 *   - The consumer (React hook, `session.stream()` facade, a CLI) owns the
 *     stores: what to do with a frame, and what "refetch" means.
 *
 * Cursor rules enforced here — from DONE-Z1 §6.2 / DONE-Z2 §8.2:
 *   1. `seq` (daemon, inside `epoch`) and `cseq` (API process, inside
 *      `cepoch`) are NEVER mixed. Half a cursor is dropped, never sent.
 *   2. `kortix.hello` / `kortix.resync` / `kortix.heartbeat` advance nothing.
 *   3. A resync means REFETCH, not guess: the runtime cursor is dropped and
 *      `onRuntimeResync` fires; the control cursor is dropped silently because
 *      the server re-emits every control snapshot right after its resync.
 *   4. A hello whose `epoch` differs from the stored one drops the stored
 *      `seq` before anything is applied.
 *   5. `seq` is dense inside an epoch, so `seq > last + 1` in one epoch is a
 *      detectable gap (`onRuntimeGap`) — the property that retires the old
 *      30s transcript tail-verify.
 *
 * Unlike the sandbox-facing stream this one NEVER parks: the upstream is the
 * Kortix API, not a possibly-archived box, so the honest terminal states are
 * "connected" and "still retrying" — capped exponential backoff, forever.
 */

import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';
import {
  readSessionStream,
  type ReadSessionStreamOptions,
  type ResolvedSessionStreamCursor,
  type SessionStreamCursor,
  type SessionStreamFrame,
  type SessionStreamRuntimeFrame,
} from '../rest/projects-client/session-stream';
import { logger } from '../http/logger';

/**
 * The event union the session's runtime dispatches — OpenCode's own wire
 * events plus the one frontend-synthesized member. Canonical definition
 * (moved here from the deleted `event-stream.ts`; the name is published).
 */
export type OpenCodeEvent =
  | OpenCodeSdkEvent
  | {
      id: string;
      type: 'lsp.client.diagnostics';
      properties: { serverID: string; path: string };
    };

/** A live stream handle: `close()` stops it. Published name — kept across the
 *  transport cutover (`session.stream()` still resolves to one). */
export interface EventStreamHandle {
  close: () => void;
}

/** Injectable clock/timer seam — defaults to the real globals. */
export interface SessionStreamTimers {
  now: () => number;
  setTimeout: (handler: () => void, timeoutMs?: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) => void;
}

const realTimers: SessionStreamTimers = {
  now: () => Date.now(),
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** The reader seam — `readSessionStream`'s exact shape, injectable for tests. */
export type SessionStreamReader = (
  projectId: string,
  sessionId: string,
  options?: ReadSessionStreamOptions,
) => AsyncGenerator<SessionStreamFrame>;

/**
 * Max quiet time before the watchdog declares the connection dead and
 * reconnects. The server heartbeats every 15s (`kortix.stream.heartbeat`), so
 * three missed beats — not one network hiccup — is what trips this.
 */
export const HEARTBEAT_TIMEOUT_MS = 45_000;

const FAST_RECONNECT_DELAY_MS = 250;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_BACKOFF_EXPONENT = 5;

export interface RuntimeResyncInfo {
  /** The daemon's stated reason (`gap-too-old` | `epoch-changed` | `ahead-of-head`), or null. */
  reason: string | null;
  /** True when the daemon rebooted under us — everything epoch-scoped is stale. */
  epochChanged: boolean;
}

export interface RuntimeGapInfo {
  fromSeq: number;
  toSeq: number;
  session?: string;
}

export interface ConnectSessionStreamOptions {
  projectId: string;
  sessionId: string;
  /** Resume position — e.g. `bundle.runtime.{epoch,seq}` so seeding and
   *  streaming cannot disagree about what is already applied. */
  cursor?: SessionStreamCursor;
  /** Every frame, in arrival order, after cursor bookkeeping. A throw here is
   *  caught and logged — one bad handler must never break the stream. */
  onFrame: (frame: SessionStreamFrame) => void;
  /** `true` on the first frame of an attempt, `false` when the attempt ends.
   *  This is the honest definition of "the stream is delivering". */
  onConnectionChange?: (connected: boolean) => void;
  /** The daemon could not replay our gap — refetch (state + newest transcript
   *  page), do not guess. The runtime cursor has already been dropped. */
  onRuntimeResync?: (info: RuntimeResyncInfo) => void;
  /** A dense-seq gap INSIDE one epoch — frames were lost between the daemon
   *  and this consumer. Reconcile the transcript tail. */
  onRuntimeGap?: (info: RuntimeGapInfo) => void;
  /** External stop signal, in addition to `close()`. */
  signal?: AbortSignal;
  /** Injectable reader (tests). Defaults to `readSessionStream`. */
  read?: SessionStreamReader;
  /** Injectable timers (tests). */
  timers?: SessionStreamTimers;
  heartbeatTimeoutMs?: number;
}

export interface SessionStreamConnection extends EventStreamHandle {
  /** The position actually applied so far — the only honest resume point. */
  cursor: () => ResolvedSessionStreamCursor;
}

/**
 * Map a runtime-channel frame to the OpenCode event the existing reducers
 * consume. `payload` is OpenCode's `properties` VERBATIM (the daemon and the
 * API both forward it untouched), so no translation layer exists — or may be
 * added — here. Frames with no replayable identity (`kortix.hello`,
 * `kortix.resync`, `kortix.heartbeat`) are connection machinery, not events.
 */
export function runtimeFrameToOpenCodeEvent(
  frame: SessionStreamRuntimeFrame,
): OpenCodeEvent | null {
  if (
    frame.type === 'kortix.hello' ||
    frame.type === 'kortix.resync' ||
    frame.type === 'kortix.heartbeat'
  ) {
    return null;
  }
  // `at` rides along: it is the instant the RUNTIME emitted the frame, and a
  // REPLAYED frame carries an old one. The store stamps "the runtime produced
  // output" from this, and stamping replay with `Date.now()` made a page load
  // look like a live turn — the composer sat on Stop for 45s after opening a
  // session whose answer had finished long before.
  return { type: frame.type, properties: frame.payload ?? {}, at: frame.at } as unknown as OpenCodeEvent;
}

export function connectSessionStream(
  options: ConnectSessionStreamOptions,
): SessionStreamConnection {
  const t = options.timers ?? realTimers;
  const read = options.read ?? readSessionStream;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  const cursor: ResolvedSessionStreamCursor = {
    epoch: options.cursor?.epoch ?? null,
    seq: options.cursor?.seq ?? null,
    cepoch: options.cursor?.cepoch ?? null,
    cseq: options.cursor?.cseq ?? null,
  };

  const outer = new AbortController();
  const stop = () => outer.abort();
  if (options.signal) {
    if (options.signal.aborted) outer.abort();
    else options.signal.addEventListener('abort', stop, { once: true });
  }

  /** Cursor bookkeeping for one frame, BEFORE it is handed to the consumer. */
  function applyCursorRules(frame: SessionStreamFrame): void {
    if (frame.channel === 'runtime') {
      const runtime = frame as SessionStreamRuntimeFrame;
      if (runtime.type === 'kortix.resync') {
        // The daemon refused our range. Adopt its epoch, drop our position,
        // and tell the consumer to refetch — never resume the old cursor.
        cursor.epoch = typeof runtime.epoch === 'string' ? runtime.epoch : null;
        cursor.seq = null;
        const reason =
          typeof (runtime as { reason?: unknown }).reason === 'string'
            ? ((runtime as { reason?: string }).reason as string)
            : null;
        try {
          options.onRuntimeResync?.({ reason, epochChanged: reason === 'epoch-changed' });
        } catch (error) {
          logger.warn('session-stream onRuntimeResync threw', { error: String(error) });
        }
        return;
      }
      if (runtime.type === 'kortix.hello') {
        // A hello from a DIFFERENT daemon boot invalidates the stored seq
        // before anything is applied (DONE-Z1 §6.2 rule 2).
        if (typeof runtime.epoch === 'string') {
          if (cursor.epoch !== null && cursor.epoch !== runtime.epoch) cursor.seq = null;
          cursor.epoch = runtime.epoch;
        }
        return;
      }
      if (typeof runtime.seq === 'number') {
        if (
          cursor.seq !== null &&
          typeof runtime.epoch === 'string' &&
          runtime.epoch === cursor.epoch &&
          runtime.seq > cursor.seq + 1
        ) {
          try {
            options.onRuntimeGap?.({
              fromSeq: cursor.seq,
              toSeq: runtime.seq,
              ...(runtime.session ? { session: runtime.session } : {}),
            });
          } catch (error) {
            logger.warn('session-stream onRuntimeGap threw', { error: String(error) });
          }
        }
        if (typeof runtime.epoch === 'string') cursor.epoch = runtime.epoch;
        cursor.seq = runtime.seq;
      }
      return;
    }
    if (frame.channel === 'control') {
      if (frame.type === 'kortix.control.resync') {
        // Snapshots supersede: the server re-emits every subsystem right
        // after this frame, so there is nothing to fetch — just resume from
        // the new epoch. (DONE-Z2 §3.2.)
        cursor.cepoch = typeof frame.cepoch === 'string' ? frame.cepoch : null;
        cursor.cseq = null;
        return;
      }
      if (typeof frame.cseq === 'number') {
        if (typeof frame.cepoch === 'string') cursor.cepoch = frame.cepoch;
        cursor.cseq = frame.cseq;
      }
    }
    // channel 'stream': connection frames advance nothing.
  }

  void (async () => {
    let retryCount = 0;
    while (!outer.signal.aborted) {
      const attemptAbort = new AbortController();
      const onOuterAbort = () => attemptAbort.abort();
      outer.signal.addEventListener('abort', onOuterAbort, { once: true });

      let delivered = false;
      let notifiedConnected = false;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      const resetHeartbeat = () => {
        t.clearTimeout(heartbeatTimer);
        heartbeatTimer = t.setTimeout(() => attemptAbort.abort(), heartbeatTimeoutMs);
      };

      try {
        const stream = read(options.projectId, options.sessionId, {
          cursor: { ...cursor },
          signal: attemptAbort.signal,
        });
        resetHeartbeat();
        for await (const frame of stream) {
          if (attemptAbort.signal.aborted) break;
          delivered = true;
          resetHeartbeat();
          if (!notifiedConnected) {
            notifiedConnected = true;
            try {
              options.onConnectionChange?.(true);
            } catch (error) {
              logger.warn('session-stream onConnectionChange threw', { error: String(error) });
            }
          }
          applyCursorRules(frame);
          try {
            options.onFrame(frame);
          } catch (error) {
            logger.warn('session-stream frame handler threw, skipping', {
              type: frame.type,
              error: String(error),
            });
          }
        }
      } catch (error) {
        if (!outer.signal.aborted && !attemptAbort.signal.aborted) {
          logger.warn('session stream attempt failed', { error: String(error) });
        }
      } finally {
        t.clearTimeout(heartbeatTimer);
        attemptAbort.abort();
        outer.signal.removeEventListener('abort', onOuterAbort);
        if (notifiedConnected) {
          try {
            options.onConnectionChange?.(false);
          } catch (error) {
            logger.warn('session-stream onConnectionChange threw', { error: String(error) });
          }
        }
      }

      if (outer.signal.aborted) break;

      // Delivered → the stream was healthy; resume fast. Frameless → back off,
      // capped, FOREVER — the API being briefly down is not a dead sandbox,
      // so there is no park state to escape from and none exists.
      retryCount = delivered ? 0 : retryCount + 1;
      const delay = delivered
        ? FAST_RECONNECT_DELAY_MS
        : Math.min(
            BASE_RECONNECT_DELAY_MS * 2 ** Math.min(retryCount - 1, MAX_BACKOFF_EXPONENT),
            MAX_RECONNECT_DELAY_MS,
          );
      await new Promise<void>((resolve) => {
        const timer = t.setTimeout(() => {
          outer.signal.removeEventListener('abort', onDelayAbort);
          resolve();
        }, delay);
        function onDelayAbort(): void {
          t.clearTimeout(timer);
          resolve();
        }
        outer.signal.addEventListener('abort', onDelayAbort, { once: true });
      });
    }
  })();

  return {
    close: () => {
      if (options.signal) options.signal.removeEventListener('abort', stop);
      outer.abort();
    },
    cursor: () => ({ ...cursor }),
  };
}
