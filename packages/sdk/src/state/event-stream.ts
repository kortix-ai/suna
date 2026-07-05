/**
 * Framework-free SSE event-stream machine, extracted verbatim (same constants,
 * same branch order, same semantics) from the connect/reconnect loop that used
 * to live inline inside `react/use-opencode-events/index.ts`'s `useEffect`.
 *
 * Zero imports of `react`, `react-query`, or any `react/*` module — this file
 * can run in any JS host (a worker, a CLI, a non-React UI). Everything that
 * depended on React Query in the original hook (cache writes, toasts, ref
 * lookups) stays in the React wrapper and reaches this module only through the
 * injected `onEvent` / `onGapRehydrate` callbacks.
 *
 * Owns: connecting to the opencode SSE endpoint, the heartbeat watchdog, event
 * coalescing + 16ms flush batching, gap detection on reconnect, and the
 * exponential-backoff reconnect loop (fast 250ms resume after a healthy
 * stream, capped exponential backoff otherwise).
 */

import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';
import { getSupabaseAccessToken, invalidateTokenCache } from '../platform/auth';
import { logger } from '../platform/logger';

/**
 * The event union this stream dispatches. Re-exported (unchanged shape) from
 * `react/use-opencode-events/types.ts` so existing importers keep working —
 * this module is now the canonical definition.
 */
export type OpenCodeEvent =
  | OpenCodeSdkEvent
  | {
      id: string;
      type: 'lsp.client.diagnostics';
      properties: { serverID: string; path: string };
    };

/** The minimal slice of `OpencodeClient` this machine actually calls. */
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
  /** The opencode client to stream events from (same client the rest of the
   *  SDK obtains via `getClient()`). */
  client: EventStreamClient;
  /** Called once per event, in dispatch order, after coalescing/flush. A
   *  throw here is caught and logged — one bad handler must never break the
   *  stream or crash the host. */
  onEvent: (event: OpenCodeEvent) => void;
  /** Called when a reconnect follows a stream gap > 5s, with the gap size in
   *  ms. Lets the host re-hydrate anything it fears went stale (e.g. replay
   *  messages for busy sessions) — the machine itself holds no host state to
   *  re-hydrate. */
  onGapRehydrate?: (gapMs: number) => void;
  /** External signal that also stops the stream when aborted (in addition to
   *  calling `close()` on the returned handle). Optional — most hosts just use
   *  `close()`. */
  signal?: AbortSignal;
  /** Test-only clock/timer override. Defaults to real `Date.now`/`setTimeout`. */
  timers?: EventStreamTimers;
}

export interface EventStreamHandle {
  /** Aborts the in-flight connection (if any), stops all reconnect/backoff
   *  activity, and clears the pending coalescing flush. Idempotent. */
  close: () => void;
}

// ---- Tunables — copied verbatim from the original hook; behavior-preserving
// extraction means these values (and the formulas that use them) must not
// drift from what's live in production. ----
const COALESCE_FLUSH_MS = 16;
const YIELD_INTERVAL_MS = 8;
const HEARTBEAT_MS = 15_000;
const STABLE_CONNECTION_MS = 10_000;
const GAP_REHYDRATE_MS = 5_000;
const FAST_RECONNECT_DELAY_MS = 250;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_BACKOFF_EXPONENT = 5;
const SSE_DEFAULT_RETRY_DELAY_MS = 3000;
const SSE_MAX_RETRY_DELAY_MS = 30_000;

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
function getCoalesceKey(event: OpenCodeEvent): string | undefined {
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
 * Connects to the opencode SSE event stream and keeps it alive: heartbeat
 * watchdog, event coalescing + batched flush, gap-triggered rehydrate signal,
 * and exponential-backoff reconnect. Framework-free — safe to call from any
 * host (the React wrapper calls this once per effect run; a non-React host can
 * call it directly).
 */
export function openEventStream(opts: OpenEventStreamOptions): EventStreamHandle {
  const { client, onEvent, onGapRehydrate, signal: externalSignal } = opts;
  const t = opts.timers ?? realTimers;

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
  // Track when the stream connected and whether it delivered any events. We
  // reset reconnect backoff only after a healthy connection (events received
  // or sustained >10s). Brief connect→drop loops keep backoff growth.
  let streamConnectedAt = 0;

  // Event coalescing queue (like the SolidJS reference)
  let queue: ({ type: string; event: OpenCodeEvent } | undefined)[] = [];
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
        console.warn('[opencode-events] event handler threw, skipping', e);
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
    while (!abortController.signal.aborted) {
      let streamHadEvents = false;
      let stableConnection = false;
      let heartbeatTimer: EventStreamTimerHandle | undefined;
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
        const result = await client.global.event({
          signal: attemptAbort.signal,
          sseDefaultRetryDelay: SSE_DEFAULT_RETRY_DELAY_MS,
          sseMaxRetryDelay: SSE_MAX_RETRY_DELAY_MS,
        });
        const { stream } = result;
        streamConnectedAt = t.now();
        lastStreamActivityTime = streamConnectedAt;

        // Heartbeat timeout — matching the reference. If no events arrive for
        // 15s, abort and reconnect. This is the ONLY recovery mechanism we
        // need — replaces the stall watchdog, reconciler, and visibility
        // handler.
        const resetHeartbeat = () => {
          t.clearTimeout(heartbeatTimer);
          heartbeatTimer = t.setTimeout(() => {
            logger.warn('SSE heartbeat timeout, forcing reconnect');
            attemptAbort.abort();
          }, HEARTBEAT_MS);
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
          ) as OpenCodeEvent;
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

        // Healthy stream if it delivered events, or if it stayed open for >10s.
        stableConnection = streamHadEvents || t.now() - streamConnectedAt > STABLE_CONNECTION_MS;
      } catch (err) {
        if (abortController.signal.aborted) break;
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
