/**
 * One SSE connection attempt and its machine: the coalescing queue, the
 * connect timeout race, the abortable read loop, and the reconnect-policy
 * helpers. `event-stream.ts` drives these; this module owns the attempt's
 * timers.
 */
import { isAuthFailure } from '../http/api/errors';
import { getSupabaseAccessToken, invalidateTokenCache } from '../http/auth';
import { logger } from '../http/logger';
import type {
  EventStreamClient,
  EventStreamConnectionState,
  EventStreamTimerHandle,
  EventStreamTimers,
  RuntimeEvent,
  StreamSubscriber,
} from './event-stream';

// ---- Tunables ----
export const COALESCE_FLUSH_MS = 16;
export const YIELD_INTERVAL_MS = 8;

/**
 * Idle watchdog budget for an ESTABLISHED stream. The sandbox daemon injects a
 * typed `kortix.keepalive` event every 20 s into the proxied runtime event
 * stream (`SSE_KEEPALIVE_INTERVAL_MS` in
 * `apps/kortix-sandbox-agent-server/src/routes/proxy/sse-keepalive.ts`), so a
 * quiet session is never silent. 60 s is three missed keepalives: the watchdog
 * fires when the path (daemon → edge → API → client) is dead, not on one late
 * frame. The API session stream sends its own `kortix.stream.heartbeat` every
 * 15 s (`STREAM_HEARTBEAT_MS`). Configurable per-stream via
 * `OpenEventStreamOptions.heartbeatTimeoutMs`.
 */
export const HEARTBEAT_MS = 60_000;

const FAST_RECONNECT_DELAY_MS = 250;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_BACKOFF_EXPONENT = 5;

/** Reconnect delays stretch by up to this fraction, so a restart does not
 *  bring every client back in lockstep. */
const RECONNECT_JITTER = 0.5;

const SSE_DEFAULT_RETRY_DELAY_MS = 3000;
const SSE_MAX_RETRY_DELAY_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 20_000;

/** An event-less attempt that dies faster than this is a "hard failure" —
 *  the fast-503 signature of a dead sandbox — even when the error carries no
 *  HTTP status (edge-generated failures surface as opaque network/CORS
 *  errors). See `maxConsecutiveHardFailures`. */
const HARD_FAILURE_WINDOW_MS = 2_000;
export const MAX_CONSECUTIVE_HARD_FAILURES = 8;

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

type PartDeltaEvent = Extract<RuntimeEvent, { type: 'message.part.delta' }> & {
  /** The wire events this one replaced, in order. Set only on a merged event. */
  coalesced?: RuntimeEvent[];
};

/**
 * Text-delta coalescing: `next` appended to `tail` as ONE event, when both are
 * deltas of the same part field (`message.part.delta`) or of the same session-log
 * block (`log.block.delta`). Else undefined.
 *
 * Only the queue's TAIL is ever merged into, so a run never crosses another
 * event and dispatch order stays the wire order. The merged event carries the
 * joined `delta`, the last wire event's `id`, and every wire event it replaced
 * in `coalesced`: a consumer that dedupes by event id (the sync store) still
 * sees each one.
 */
function mergePartDelta(tail: RuntimeEvent | undefined, next: RuntimeEvent): RuntimeEvent | undefined {
  if (!tail || tail.type !== next.type) return undefined;
  if (next.type === 'message.part.delta') {
    const a = (tail as typeof next).properties;
    const b = next.properties;
    if (a.partID !== b.partID || a.field !== b.field || a.messageID !== b.messageID || a.sessionID !== b.sessionID) return undefined;
  } else if ((next.type as string) === 'log.block.delta') {
    // The session log's text delta (`kortix.session/2`): one block of one message of one thread.
    const a = tail.properties as { thread_id?: unknown; message_id?: unknown; block_id?: unknown; delta?: unknown };
    const b = next.properties as typeof a;
    if (typeof a.delta !== 'string' || typeof b.delta !== 'string') return undefined;
    if (a.thread_id !== b.thread_id || a.message_id !== b.message_id || a.block_id !== b.block_id) return undefined;
  } else {
    return undefined;
  }
  const a = tail.properties as { delta: string };
  const b = next.properties as { delta: string };
  // The list is this module's own (made on a run's first merge), so it grows in place.
  const wire = (tail as PartDeltaEvent).coalesced ?? [tail];
  wire.push(next);
  return { ...next, properties: { ...b, delta: a.delta + b.delta }, coalesced: wire } as PartDeltaEvent;
}

/**
 * The event coalescing queue (like the SolidJS reference): pushes replace
 * earlier same-key events and merge part deltas, and a 16ms flush timer
 * batches the queue into one dispatch burst.
 */
export function createEventCoalescer(
  t: EventStreamTimers,
  dispatch: (event: RuntimeEvent) => void,
): {
  push: (event: RuntimeEvent) => void;
  flush: () => void;
  clearTimer: () => void;
} {
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

    for (const item of events) {
      if (!item) continue;
      // A single subscriber's handler must never break the stream OR crash
      // the host, and must never stop the OTHER subscribers from receiving
      // this event — `dispatchToSubscribers` catches per-subscriber. e.g. a
      // handler calls getClient() before the sandbox URL is pinned (during a
      // session switch) — that throw used to escape to the route error
      // boundary. Swallow + log; the next events + retries recover.
      dispatch(item.event);
    }
  };

  const schedule = () => {
    if (flushTimer) return;
    const elapsed = t.now() - lastFlush;
    flushTimer = t.setTimeout(flush, Math.max(0, COALESCE_FLUSH_MS - elapsed));
  };

  return {
    push(event) {
      // The tail is never a replaced slot: a replacement pushes right after.
      const merged = mergePartDelta(queue[queue.length - 1]?.event, event);
      if (merged) {
        queue[queue.length - 1] = { type: merged.type, event: merged };
      } else {
        const ck = getCoalesceKey(event);
        if (ck) {
          const existing = coalesced.get(ck);
          if (existing !== undefined) {
            queue[existing] = undefined;
          }
          coalesced.set(ck, queue.length);
        }
        queue.push({ type: event.type, event });
      }
      schedule();
    },
    flush,
    clearTimer: () => {
      if (flushTimer) t.clearTimeout(flushTimer);
    },
  };
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

/** Calls `fn` on every current subscriber. A throwing subscriber must
 *  never break dispatch to the others or crash the host. */
export function dispatchToStreamSubscribers<A extends unknown[]>(
  subscribers: Set<StreamSubscriber>,
  pick: (sub: StreamSubscriber) => ((...a: A) => void) | undefined,
  ...args: A
): void {
  for (const sub of subscribers) {
    const fn = pick(sub);
    if (!fn) continue;
    try {
      fn(...args);
    } catch (e) {
      console.warn('[opencode-events] subscriber handler threw, skipping', e);
    }
  }
}

/** The SSE connect call itself, raced against `connectTimeoutMs`. A
 *  black-holed proxy can swallow the request with no error, no data, and
 *  no close — the heartbeat watchdog only starts once this resolves, so
 *  it can't rescue a hung connect. On timeout, abort the attempt (cancels
 *  the underlying request, same as any other reconnect) and reject so the
 *  attempt falls into its catch block and retries through the normal
 *  backoff path, exactly like any other connect failure. */
async function connectEventStream(
  client: EventStreamClient,
  t: EventStreamTimers,
  connectTimeoutMs: number,
  attemptAbort: AbortController,
): Promise<{ stream: AsyncIterable<unknown> }> {
  return new Promise<{ stream: AsyncIterable<unknown> }>((resolve, reject) => {
    let settled = false;
    const connectTimer = t.setTimeout(() => {
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
        // CRITICAL: caps the vendor client's OWN internal reconnect loop
        // to a single attempt. `@opencode-ai/sdk`'s `createSseClient`
        // wraps every connection in its own `while(true)` retry-with-
        // backoff generator that swallows failures and silently
        // schedules its next fetch via a plain `setTimeout` sleep that
        // does NOT observe `signal` — aborting mid-sleep only stops it
        // once the sleep elapses and the generator wakes up to check
        // `signal.aborted`. Left unset (the old default), that inner
        // loop runs CONCURRENTLY with this module's own outer
        // connect/backoff loop below: the moment we abort a stalled
        // attempt (heartbeat timeout, gap reconnect, or a fresh `close()`)
        // and immediately open the next one, the previous vendor-level
        // generator can still be mid-sleep and — on a race — wakes up
        // and fires ONE MORE fetch before it finally notices the abort,
        // stacking a second live connection on top of the new attempt.
        // On a flaky self-host sandbox (frequent brief-unreachable →
        // reconnect cycles) this piles up fast: every retry can leave a
        // stray in-flight fetch behind, and under HTTP/1.1's 6-per-origin
        // cap those leaked connections alone can saturate the pool and
        // queue out every other request (/projects, /sessions, ...).
        // Setting this to 1 makes a failed fetch complete the generator
        // (a clean `done`, no throw, no internal retry/sleep) instead of
        // scheduling its own reconnect — so THIS module's outer loop is
        // the only thing that ever decides to open a new connection, and
        // it only ever does so after the previous attempt's
        // `attemptAbort.abort()` has already run (see the `finally`
        // block below).
        sseMaxRetryAttempts: 1,
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
}

/** Consume an established stream: queue + coalesce + 16ms flush + yield
 *  every 8ms. Returns whether the stream delivered any work.
 *
 *  The read itself has to be abortable, not just checked between
 *  reads. If the underlying `.next()` parks (server stops sending, no
 *  error, no close), a plain `for await` never yields control back to
 *  this loop body, so a heartbeat/abort that fires while parked would
 *  never actually be observed. Race each read against the
 *  heartbeat/abort signals instead — whichever settles first wins. */
async function readEventStream(
  stream: AsyncIterable<unknown>,
  t: EventStreamTimers,
  signal: AbortSignal,
  coalescer: ReturnType<typeof createEventCoalescer>,
  onEventful: () => void,
): Promise<boolean> {
  // Events other than the connection's own `server.connected` greeting.
  let streamHadWork = false;
  let yieldedAt = t.now();
  const iterator = stream[Symbol.asyncIterator]();
  while (!signal.aborted) {
    const nextOutcome = iterator.next().then(
      (result) => ({ kind: 'next' as const, result }),
      (error) => ({ kind: 'error' as const, error }),
    );
    const abortWatch = onceAborted(signal);
    const outcome = await Promise.race([
      nextOutcome,
      abortWatch.promise.then(() => ({ kind: 'aborted' as const })),
    ]);
    abortWatch.cleanup();

    if (outcome.kind === 'aborted') break;
    if (outcome.kind === 'error') throw outcome.error;
    if (outcome.result.done) break;

    onEventful();
    const raw: unknown = outcome.result.value;
    const e = (
      raw && typeof raw === 'object' && 'payload' in raw ? raw.payload : raw
    ) as RuntimeEvent;
    if (!e?.type) continue;
    // The connection's own greeting is not work that a drop could lose.
    if (e.type !== 'server.connected') streamHadWork = true;

    coalescer.push(e);

    if (t.now() - yieldedAt < YIELD_INTERVAL_MS) continue;
    await new Promise<void>((resolve) => t.setTimeout(resolve, 0));
    // The budget starts when reading resumes. The host renders inside the
    // yield; counting that wait as reading made every later event yield
    // again, one event per render, so the transcript trailed the wire.
    yieldedAt = t.now();
  }
  return streamHadWork;
}

/** A HARD failure delivered zero events AND either carried an HTTP-level
 *  status (the vendor client wraps non-2xx as `Error` with `cause: { status }`
 *  — see @opencode-ai/sdk's error-interceptor) or died within
 *  HARD_FAILURE_WINDOW_MS (edge 503s surface as opaque network/CORS errors
 *  with no status attached) — the "dead sandbox" signature the driver's
 *  give-up (park) check keys on. */
export function isHardAttemptFailure(
  streamHadWork: boolean,
  attemptError: unknown,
  attemptDurationMs: number,
): boolean {
  const httpStatus = (attemptError as { cause?: { status?: unknown } } | null)?.cause?.status;
  // A greeting alone is not delivery: a proxy that says hello and closes
  // is as dead as one that refuses the connect.
  return (
    !streamHadWork &&
    ((typeof httpStatus === 'number' && httpStatus >= 400) ||
      attemptDurationMs < HARD_FAILURE_WINDOW_MS)
  );
}

/** Tell every subscriber the stream parked (gave up). The caller drops its
 *  own connection state and stops the loop. */
export function parkStream(
  subscribers: Set<StreamSubscriber>,
  consecutiveFailures: number,
  lastError: unknown,
): void {
  logger.error('SSE event stream parked — giving up after consecutive hard failures', {
    consecutiveFailures,
    lastError: String(lastError),
  });
  // A subscriber's park handler must never crash the (already-
  // terminal) stream machine, and must never stop another
  // subscriber's from firing — `dispatchToStreamSubscribers` catches per
  // subscriber.
  dispatchToStreamSubscribers(subscribers, (sub) => sub.onParked, {
    consecutiveFailures,
    lastError,
  });
}

/** The next reconnect delay: the 250ms fast path after a stable stream until
 *  it proves unstable, else exponential backoff (1s → 30s cap) with jitter. */
export function reconnectDelay(retryCount: number, fastPath: boolean, t: EventStreamTimers): number {
  const baseDelay = fastPath
    ? FAST_RECONNECT_DELAY_MS
    : Math.min(
        BASE_RECONNECT_DELAY_MS * 2 ** Math.min(retryCount - 1, MAX_BACKOFF_EXPONENT),
        MAX_RECONNECT_DELAY_MS,
      );
  return Math.round(baseDelay * (1 + RECONNECT_JITTER * (t.random?.() ?? 0)));
}

/** Resolve after `delayMs`, or immediately when `signal` aborts. */
export function abortableDelay(t: EventStreamTimers, signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = t.setTimeout(resolve, delayMs);
    const onAbort = () => {
      t.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** What one connect attempt produced: whether it delivered work, whether it
 *  counts as stable (the driver's fast-path input), and the error it died to
 *  (null when it ended cleanly — stream `done` — as well as on an outer
 *  abort, which the driver observes through its own check). */
interface EventStreamAttemptOutcome {
  streamHadWork: boolean;
  stableConnection: boolean;
  error: unknown;
}

/** One connect attempt: the SSE connect race against `connectTimeoutMs`, the
 *  driver's gap repair once the connection exists, the heartbeat watchdog,
 *  and the abortable read loop that queues + coalesces events. Owns its
 *  timers (`connectTimer`, `heartbeatTimer`, `attemptAbort`) and releases
 *  them in its `finally`; an error is logged (with a token refresh on auth
 *  failures) and returned as the outcome. The driver decides what the
 *  outcome means — park, backoff, fast path. */
export async function connectAttempt(deps: {
  client: EventStreamClient;
  t: EventStreamTimers;
  connectTimeoutMs: number;
  heartbeatTimeoutMs: number;
  outerSignal: AbortSignal;
  retryCount: number;
  setConnectionState: (state: EventStreamConnectionState) => void;
  /** Runs once the connect promise resolves, before the first read — the
   *  driver repairs a pending gap there (see `pendingGap`). */
  onConnected: () => void;
  coalescer: ReturnType<typeof createEventCoalescer>;
}): Promise<EventStreamAttemptOutcome> {
  const {
    client,
    t,
    connectTimeoutMs,
    heartbeatTimeoutMs,
    outerSignal,
    retryCount,
    setConnectionState,
    onConnected,
    coalescer,
  } = deps;
  let streamHadWork = false;
  let stableConnection = false;
  let heartbeatTimer: EventStreamTimerHandle | undefined;
  // What this attempt died to (null = clean end) — feeds the hard-failure
  // classification the driver runs on the outcome.
  let attemptError: unknown = null;
  // Per-attempt controller passed to the SSE client. Aborting it is what
  // actually cancels the underlying network reader — the vendor client
  // only cancels on the signal IT was handed. It aborts when EITHER the
  // heartbeat fires OR the outer controller aborts (linked below), so a
  // heartbeat-forced reconnect tears the old connection down instead of
  // leaving it parked/leaking while a new one opens.
  const attemptAbort = new AbortController();

  setConnectionState('connecting');
  const outerLink = onceAborted(outerSignal);
  outerLink.promise.then(() => attemptAbort.abort());
  try {
    const { stream } = await connectEventStream(client, t, connectTimeoutMs, attemptAbort);

    onConnected();

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

    streamHadWork = await readEventStream(stream, t, attemptAbort.signal, coalescer, () => {
      setConnectionState('open');
      resetHeartbeat();
    });

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
    stableConnection = streamHadWork;
  } catch (err) {
    attemptError = err;
    // An outer abort is a deliberate stop, not a failure: no error log,
    // no token refresh.
    if (outerSignal.aborted) return { streamHadWork, stableConnection, error: attemptError };
    const errStr = String(err);
    // By status or `AuthError`, never by message text. The vendor client puts
    // the HTTP status on `cause`.
    const isAuthError =
      isAuthFailure(err) || isAuthFailure((err as { cause?: unknown } | null)?.cause);
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
    coalescer.flush();
  }
  return { streamHadWork, stableConnection, error: attemptError };
}
