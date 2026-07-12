/**
 * Framework-free SSE event-stream machine, extracted verbatim (same constants,
 * same branch order, same semantics) from the connect/reconnect loop that used
 * to live inline inside `react/use-runtime-events/index.ts`'s `useEffect`.
 *
 * Zero imports of `react`, `react-query`, or any `react/*` module — this file
 * can run in any JS host (a worker, a CLI, a non-React UI). Everything that
 * depended on React Query in the original hook (cache writes, toasts, ref
 * lookups) stays in the React wrapper and reaches this module only through the
 * injected `onEvent` / `onGapRehydrate` callbacks.
 *
 * Owns: connecting to the runtime SSE endpoint (with a connect timeout), the
 * idle heartbeat watchdog, event coalescing + 16ms flush batching, gap
 * detection on reconnect, the exponential-backoff reconnect loop (fast 250ms
 * resume after an eventful stream, capped exponential backoff otherwise), and
 * the give-up "parked" terminal state for streams pointed at dead sandboxes
 * (see `maxConsecutiveHardFailures`/`onParked`).
 */

import type { Event as RuntimeSdkEvent } from '../runtime/wire-types';
import { getSupabaseAccessToken, invalidateTokenCache } from '../http/auth';
import { logger } from '../http/logger';

/**
 * The event union this stream dispatches. Re-exported (unchanged shape) from
 * `react/use-runtime-events/types.ts` so existing importers keep working —
 * this module is now the canonical definition.
 */
export type RuntimeEvent =
  | RuntimeSdkEvent
  | {
      id: string;
      type: 'lsp.client.diagnostics';
      properties: { serverID: string; path: string };
    };

/** The minimal slice of `RuntimeClient` this machine actually calls. */
export interface EventStreamClient {
  global: {
    event: (opts: {
      signal: AbortSignal;
      sseDefaultRetryDelay?: number;
      sseMaxRetryDelay?: number;
    }) => Promise<{ stream: AsyncIterable<unknown> }>;
  };
}

/** A timer handle — opaque, only ever round-tripped through `setTimeout`/`clearTimeout`. */
export type EventStreamTimerHandle = ReturnType<typeof setTimeout>;

/** Injectable clock/timer seam — defaults to the real globals. Lets tests
 *  drive the reconnect/backoff/heartbeat/coalescing timing deterministically
 *  (a manual fake clock) instead of depending on real wall-clock delays. */
export interface EventStreamTimers {
  now: () => number;
  setTimeout: (handler: () => void, timeoutMs?: number) => EventStreamTimerHandle;
  clearTimeout: (handle: EventStreamTimerHandle | undefined) => void;
}

const realTimers: EventStreamTimers = {
  now: () => Date.now(),
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface OpenEventStreamOptions {
  /** The runtime client to stream events from (same client the rest of the
   *  SDK obtains via `getClient()`). */
  client: EventStreamClient;
  /** Called once per event, in dispatch order, after coalescing/flush. A
   *  throw here is caught and logged — one bad handler must never break the
   *  stream or crash the host. */
  onEvent: (event: RuntimeEvent) => void;
  /** Called when a reconnect follows a stream gap > 5s, with the gap size in
   *  ms. Lets the host re-hydrate anything it fears went stale (e.g. replay
   *  messages for busy sessions) — the machine itself holds no host state to
   *  re-hydrate. */
  onGapRehydrate?: (gapMs: number) => void;
  /** External signal that also stops the stream when aborted (in addition to
   *  calling `close()` on the returned handle). Optional — most hosts just use
   *  `close()`. */
  signal?: AbortSignal;
  /**
   * Max time to wait for the initial `client.global.event()` call to resolve
   * before treating the attempt as hung, aborting it, and retrying through the
   * normal reconnect/backoff path. Guards against a black-holed proxy that
   * swallows the connect request silently (no error, no data, no close) —
   * the heartbeat watchdog can't help here since it only starts AFTER connect
   * resolves. Defaults to 20s.
   */
  connectTimeoutMs?: number;
  /**
   * Max quiet time on an ESTABLISHED stream before the heartbeat watchdog
   * declares it dead, aborts it, and reconnects. Defaults to 60s — see the
   * `HEARTBEAT_MS` comment for why it must stay well above any real idle gap
   * until the server ships keepalive frames.
   */
  heartbeatTimeoutMs?: number;
  /**
   * Give-up threshold: after this many CONSECUTIVE hard failures (attempts
   * that never delivered a single event and died to an HTTP-level error or
   * within 2s — the signature of a dead/archived sandbox whose proxy 503s
   * every connect), the stream stops retrying and parks (see `onParked`).
   * Any attempt that delivers an event, or that fails slowly without an HTTP
   * status (e.g. a connect-timeout on a black-holed proxy), resets the
   * counter. Defaults to 8 — combined with exponential backoff (1s → 30s
   * cap) that spreads the give-up over roughly two minutes.
   */
  maxConsecutiveHardFailures?: number;
  /**
   * Fired ONCE if the stream parks (gives up) after
   * `maxConsecutiveHardFailures` consecutive hard failures. A parked stream
   * is TERMINAL for this handle: no further connect attempts are made, and
   * there is no resume — the host should treat the runtime as gone (drop the
   * stream, surface UI) and, if it believes the sandbox is back, open a
   * fresh stream with a new `openEventStream()` call. `close()` on a parked
   * handle stays safe/idempotent.
   */
  onParked?: (reason: EventStreamParkedInfo) => void;
  /** Test-only clock/timer override. Defaults to real `Date.now`/`setTimeout`. */
  timers?: EventStreamTimers;
}

/** Payload for {@link OpenEventStreamOptions.onParked}. */
export interface EventStreamParkedInfo {
  /** How many consecutive hard failures triggered the park. */
  consecutiveFailures: number;
  /** The error from the final failed attempt (null if it ended without one). */
  lastError: unknown;
}

export interface EventStreamHandle {
  /** Aborts the in-flight connection (if any), stops all reconnect/backoff
   *  activity, and clears the pending coalescing flush. Idempotent — safe to
   *  call on a stream that has already parked (see `onParked`). */
  close: () => void;
}

// ---- Tunables ----
const COALESCE_FLUSH_MS = 16;
const YIELD_INTERVAL_MS = 8;
/**
 * Idle watchdog budget for an ESTABLISHED stream. The server currently emits
 * NO idle keepalive frames, so a healthy-but-quiet session produces genuinely
 * long silent stretches — a budget below the real idle gap makes the watchdog
 * kill perfectly healthy connections on a timer (the old 15s value guaranteed
 * a kill every 15s of quiet, by design). 60s keeps the watchdog able to catch
 * genuinely dead sockets while tolerating normal idle. When the server ships
 * `: keepalive` comment frames this can come back down toward 2× the
 * keepalive cadence. Configurable per-stream via
 * `OpenEventStreamOptions.heartbeatTimeoutMs`.
 */
const HEARTBEAT_MS = 60_000;
const GAP_REHYDRATE_MS = 5_000;
const FAST_RECONNECT_DELAY_MS = 250;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_BACKOFF_EXPONENT = 5;
const SSE_DEFAULT_RETRY_DELAY_MS = 3000;
const SSE_MAX_RETRY_DELAY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
/** An event-less attempt that dies faster than this is a "hard failure" —
 *  the fast-503 signature of a dead sandbox — even when the error carries no
 *  HTTP status (edge-generated failures surface as opaque network/CORS
 *  errors). See `maxConsecutiveHardFailures`. */
const HARD_FAILURE_WINDOW_MS = 2_000;
const MAX_CONSECUTIVE_HARD_FAILURES = 8;

/**
 * Coalescing keys — determines which events can replace earlier ones in the
 * same 16ms flush batch.
 *
 * NOTE: message.part.updated is intentionally NOT coalesced. While the server
 * sends full part state each time, coalescing can cause a stale snapshot to be
 * the sole survivor of a batch. When that stale snapshot is processed before
 * any deltas, it inserts the part with wrong/partial text (prefix-growth guard
 * can't help — nothing to compare against). The upsertPart prefix-growth guard
 * efficiently rejects stale snapshots with a no-op return, so processing every
 * snapshot has minimal cost.
 */
function getCoalesceKey(event: RuntimeEvent): string | undefined {
  if (event.type === 'session.status') {
    return `session.status:${(event.properties as any).sessionID}`;
  }
  if (event.type === 'lsp.updated') return 'lsp.updated';
  return undefined;
}

/**
 * A promise that resolves the moment `signal` fires 'abort' (or immediately,
 * if it's already aborted), plus a `cleanup` to remove the listener when it
 * loses a race. Used to make an in-flight `iterator.next()` read abortable:
 * without this, a parked read (server stops sending, no error, no close)
 * would never let a fired heartbeat/abort be observed, since nothing wakes
 * the pending read.
 */
function onceAborted(signal: AbortSignal): { promise: Promise<void>; cleanup: () => void } {
  if (signal.aborted) return { promise: Promise.resolve(), cleanup: () => {} };
  let handler: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    handler = () => resolve();
    signal.addEventListener('abort', handler, { once: true });
  });
  return { promise, cleanup: () => signal.removeEventListener('abort', handler) };
}

/**
 * Connects to the runtime SSE event stream and keeps it alive: heartbeat
 * watchdog, event coalescing + batched flush, gap-triggered rehydrate signal,
 * and exponential-backoff reconnect. Framework-free — safe to call from any
 * host (the React wrapper calls this once per effect run; a non-React host can
 * call it directly).
 */
export function openEventStream(opts: OpenEventStreamOptions): EventStreamHandle {
  const { client, onEvent, onGapRehydrate, onParked, signal: externalSignal } = opts;
  const t = opts.timers ?? realTimers;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_MS;
  const maxConsecutiveHardFailures =
    opts.maxConsecutiveHardFailures ?? MAX_CONSECUTIVE_HARD_FAILURES;

  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) abortController.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Track last stream activity (connect or event) to gate reconnect hydration.
  // Using only "last event" causes hydrate storms when the server rotates
  // idle SSE connections that carried no events.
  let lastStreamActivityTime = t.now();

  // Event coalescing queue (like the SolidJS reference)
  let queue: ({ type: string; event: RuntimeEvent } | undefined)[] = [];
  let flushTimer: EventStreamTimerHandle | undefined;
  let lastFlush = 0;

  // Coalescing map — replaces earlier events of the same key
  const coalesced = new Map<string, number>();

  const flush = () => {
    if (flushTimer) t.clearTimeout(flushTimer);
    flushTimer = undefined;
    if (queue.length === 0) return;

    const events = queue;
    queue = [];
    coalesced.clear();
    lastFlush = t.now();
    lastStreamActivityTime = t.now();

    for (const item of events) {
      if (!item) continue;
      try {
        onEvent(item.event);
      } catch (e) {
        // A single event handler must never break the stream OR crash the
        // host. e.g. a handler calls getClient() before the sandbox URL is
        // pinned (during a session switch) — that throw used to escape to the
        // route error boundary. Swallow + log; the next events + retries
        // recover.
        console.warn('[runtime-events] event handler threw, skipping', e);
      }
    }
  };

  const schedule = () => {
    if (flushTimer) return;
    const elapsed = t.now() - lastFlush;
    flushTimer = t.setTimeout(flush, Math.max(0, COALESCE_FLUSH_MS - elapsed));
  };

  // Consume the stream in the background with automatic retry
  (async () => {
    let retryCount = 0;
    // Consecutive hard-failure streak — see `maxConsecutiveHardFailures`.
    // Survives across attempts; reset by any attempt that delivered events
    // or that failed slowly without an HTTP status.
    let consecutiveHardFailures = 0;
    while (!abortController.signal.aborted) {
      let streamHadEvents = false;
      let stableConnection = false;
      let heartbeatTimer: EventStreamTimerHandle | undefined;
      let connectTimer: EventStreamTimerHandle | undefined;
      // What this attempt died to (null = clean end), plus when it started —
      // both feed the hard-failure classification below the try block.
      let attemptError: unknown = null;
      const attemptStartedAt = t.now();
      // Per-attempt controller passed to the SSE client. Aborting it is what
      // actually cancels the underlying network reader — the vendor client
      // only cancels on the signal IT was handed. It aborts when EITHER the
      // heartbeat fires OR the outer controller aborts (linked below), so a
      // heartbeat-forced reconnect tears the old connection down instead of
      // leaving it parked/leaking while a new one opens.
      const attemptAbort = new AbortController();
      const outerLink = onceAborted(abortController.signal);
      outerLink.promise.then(() => attemptAbort.abort());
      try {
        // Race the connect call itself against `connectTimeoutMs`. A
        // black-holed proxy can swallow this request with no error, no data,
        // and no close — the heartbeat watchdog below only starts once this
        // resolves, so it can't rescue a hung connect. On timeout, abort this
        // attempt (cancels the underlying request, same as any other
        // reconnect) and reject so it falls into the catch block below and
        // retries through the normal backoff path, exactly like any other
        // connect failure.
        const result = await new Promise<{ stream: AsyncIterable<unknown> }>((resolve, reject) => {
          let settled = false;
          connectTimer = t.setTimeout(() => {
            if (settled) return;
            settled = true;
            logger.warn('SSE connect timed out, forcing reconnect', { connectTimeoutMs });
            attemptAbort.abort();
            reject(new Error(`SSE connect timed out after ${connectTimeoutMs}ms`));
          }, connectTimeoutMs);
          client.global
            .event({
              signal: attemptAbort.signal,
              sseDefaultRetryDelay: SSE_DEFAULT_RETRY_DELAY_MS,
              sseMaxRetryDelay: SSE_MAX_RETRY_DELAY_MS,
            })
            .then(
              (value) => {
                if (settled) return;
                settled = true;
                t.clearTimeout(connectTimer);
                resolve(value);
              },
              (err) => {
                if (settled) return;
                settled = true;
                t.clearTimeout(connectTimer);
                reject(err);
              },
            );
        });
        const { stream } = result;
        lastStreamActivityTime = t.now();

        // Heartbeat timeout — if no events arrive within the idle budget
        // (default 60s, see HEARTBEAT_MS for why), abort and reconnect. This
        // is the ONLY recovery mechanism we need on an established stream —
        // replaces the stall watchdog, reconciler, and visibility handler.
        const resetHeartbeat = () => {
          t.clearTimeout(heartbeatTimer);
          heartbeatTimer = t.setTimeout(() => {
            logger.warn('SSE heartbeat timeout, forcing reconnect');
            attemptAbort.abort();
          }, heartbeatTimeoutMs);
        };
        resetHeartbeat();

        // Consume stream: queue + coalesce + 16ms flush + yield every 8ms.
        //
        // The read itself has to be abortable, not just checked between
        // reads. If the underlying `.next()` parks (server stops sending, no
        // error, no close), a plain `for await` never yields control back to
        // this loop body, so a heartbeat/abort that fires while parked would
        // never actually be observed. Race each read against the
        // heartbeat/abort signals instead — whichever settles first wins.
        let yieldedAt = t.now();
        const iterator = stream[Symbol.asyncIterator]();
        while (!attemptAbort.signal.aborted) {
          const nextOutcome = iterator.next().then(
            (result) => ({ kind: 'next' as const, result }),
            (error) => ({ kind: 'error' as const, error }),
          );
          const abortWatch = onceAborted(attemptAbort.signal);
          const outcome = await Promise.race([
            nextOutcome,
            abortWatch.promise.then(() => ({ kind: 'aborted' as const })),
          ]);
          abortWatch.cleanup();

          if (outcome.kind === 'aborted') break;
          if (outcome.kind === 'error') throw outcome.error;
          if (outcome.result.done) break;

          streamHadEvents = true;
          resetHeartbeat();
          const raw = outcome.result.value as any;
          const e = (
            raw && typeof raw === 'object' && 'payload' in raw ? raw.payload : raw
          ) as RuntimeEvent;
          if (!e?.type) continue;

          const ck = getCoalesceKey(e);
          if (ck) {
            const existing = coalesced.get(ck);
            if (existing !== undefined) {
              queue[existing] = undefined;
            }
            coalesced.set(ck, queue.length);
          }
          queue.push({ type: (e as any).type, event: e });
          schedule();

          if (t.now() - yieldedAt < YIELD_INTERVAL_MS) continue;
          yieldedAt = t.now();
          await new Promise<void>((resolve) => t.setTimeout(resolve, 0));
        }

        // Healthy stream ONLY if it actually delivered events. There used to
        // be a time-based OR-branch here ("or stayed open >10s") — that was a
        // prod reconnect storm: anything that kills idle connections on a
        // period ABOVE that threshold (our own heartbeat watchdog, an idle
        // proxy timeout, server-side rotation) made every idle disconnect
        // look "stable", which reset retryCount and locked the loop into the
        // 250ms fast-reconnect path forever (~236 reconnects/hour/stream).
        // An idle disconnect — watchdog-triggered or natural — must ride the
        // exponential backoff (1s → 30s cap) instead; the moment a
        // reconnected stream delivers a real event, backoff resets and the
        // fast path returns. Missed-while-waiting events are covered by the
        // gap-rehydrate signal below.
        stableConnection = streamHadEvents;
      } catch (err) {
        if (abortController.signal.aborted) break;
        attemptError = err;
        const errStr = String(err);
        const isAuthError =
          errStr.includes('401') ||
          errStr.includes('403') ||
          errStr.includes('Unauthorized') ||
          errStr.includes('Token refresh failed');
        logger.error('SSE event stream error', {
          error: errStr,
          retryCount,
          isAuthError,
        });

        // On auth errors, invalidate the token cache and fetch a fresh token.
        // This ensures all callers (SSE, health check, SDK) immediately use
        // the refreshed token instead of serving stale cached ones for 30s.
        if (isAuthError) {
          try {
            invalidateTokenCache();
            await getSupabaseAccessToken();
            logger.info('SSE: refreshed auth token after auth error');
          } catch (refreshErr) {
            logger.error('SSE: failed to refresh auth token', {
              error: String(refreshErr),
            });
          }
        }
      } finally {
        t.clearTimeout(heartbeatTimer);
        t.clearTimeout(connectTimer);
        // Release the reader/connection if we left the loop for any reason
        // other than an already-fired abort (e.g. stream `done`, or a thrown
        // error), and detach the outer-abort listener so it can't accumulate
        // across reconnects.
        attemptAbort.abort();
        outerLink.cleanup();
        flush();
      }

      // Stream ended or errored — reconnect with exponential backoff.
      // ERR_INCOMPLETE_CHUNKED_ENCODING is normal when the server closes the
      // SSE connection between response cycles. Minimum 1s delay even on
      // first retry to avoid reconnection storms when the server is flapping
      // (connect → immediate disconnect loops).
      if (abortController.signal.aborted) break;

      // ── Give-up (park) check — the "dead sandbox" terminal state. ────────
      // A stream pointed at an archived/stopped session's sandbox otherwise
      // retries FOREVER: the proxy 503s every `/global/event` connect, and
      // prod showed continuous 503 loops from several dead sandboxes at once.
      // Classify this attempt: a HARD failure delivered zero events AND
      // either carried an HTTP-level status (the runtime client wraps non-2xx
      // as `Error` with `cause: { status }`) or died within HARD_FAILURE_WINDOW_MS (edge 503s
      // surface as opaque network/CORS errors with no status attached).
      // Slow failures without a status (a black-holed connect that hit the
      // 20s connect timeout) and anything that streamed a real event reset
      // the streak. After `maxConsecutiveHardFailures` in a row — spread
      // over ~2 minutes by the exponential backoff below — park for good.
      const attemptDurationMs = t.now() - attemptStartedAt;
      const httpStatus = (attemptError as { cause?: { status?: unknown } } | null)?.cause?.status;
      const isHardFailure =
        !streamHadEvents &&
        ((typeof httpStatus === 'number' && httpStatus >= 400) ||
          attemptDurationMs < HARD_FAILURE_WINDOW_MS);
      consecutiveHardFailures = isHardFailure ? consecutiveHardFailures + 1 : 0;
      if (consecutiveHardFailures >= maxConsecutiveHardFailures) {
        logger.error('SSE event stream parked — giving up after consecutive hard failures', {
          consecutiveFailures: consecutiveHardFailures,
          lastError: String(attemptError),
        });
        try {
          onParked?.({ consecutiveFailures: consecutiveHardFailures, lastError: attemptError });
        } catch (parkedHandlerErr) {
          // A host's park handler must never crash the (already-terminal)
          // stream machine.
          console.warn('[runtime-events] onParked handler threw', parkedHandlerErr);
        }
        break;
      }

      // Re-hydrate messages for loaded sessions when the SSE gap was
      // significant (>5s). Events missed during the gap (e.g. streaming
      // assistant response) would never arrive, leaving the UI stale until
      // the user manually refreshes.
      const gap = t.now() - lastStreamActivityTime;
      if (gap > GAP_REHYDRATE_MS) {
        onGapRehydrate?.(gap);
      }

      if (stableConnection) {
        // Fast reconnect after healthy streams so live streaming resumes
        // immediately.
        retryCount = 0;
      } else {
        retryCount++;
        if (retryCount > 1) {
          logger.warn('SSE event stream reconnecting', { retryCount });
        }
      }
      const delay = stableConnection
        ? FAST_RECONNECT_DELAY_MS
        : Math.min(
            BASE_RECONNECT_DELAY_MS * 2 ** Math.min(retryCount - 1, MAX_BACKOFF_EXPONENT),
            MAX_RECONNECT_DELAY_MS,
          );
      await new Promise<void>((resolve) => {
        const timer = t.setTimeout(resolve, delay);
        const onAbort = () => {
          t.clearTimeout(timer);
          resolve();
        };
        abortController.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  })();

  return {
    close: () => {
      abortController.abort();
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      if (flushTimer) t.clearTimeout(flushTimer);
    },
  };
}

// The curated chat-event union built on top of this stream's `RuntimeEvent` —
// re-exported here (additive only) so a host that imports the SSE primitive
// from this subpath (`@kortix/sdk/event-stream`) can reach the chat-narrowing
// helpers from the same import without a second subpath. Canonical definition
// lives in `./chat-events.ts`.
export {
  heartbeatGapEvent,
  narrowChatEvent,
  type KortixChatEvent,
  type KortixChatEventConnection,
  type KortixChatEventHeartbeatGap,
  type KortixChatEventMessageRemoved,
  type KortixChatEventMessageUpdated,
  type KortixChatEventPartRemoved,
  type KortixChatEventPartUpdated,
  type KortixChatEventPermissionAsked,
  type KortixChatEventPermissionReplied,
  type KortixChatEventQuestionAnswered,
  type KortixChatEventQuestionAsked,
  type KortixChatEventSessionError,
  type KortixChatEventSessionIdle,
  type KortixChatEventSessionStatus,
  type KortixChatEventTodoUpdated,
  type KortixChatQuestionInfo,
  type KortixChatQuestionOption,
  type KortixChatToolRef,
} from './chat-events';
