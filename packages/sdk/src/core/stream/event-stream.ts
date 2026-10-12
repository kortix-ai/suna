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
 * Owns: connecting to the opencode SSE endpoint (with a connect timeout), the
 * idle heartbeat watchdog, event coalescing + 16ms flush batching, gap
 * detection on reconnect, the exponential-backoff reconnect loop (fast 250ms
 * resume after an eventful stream, capped exponential backoff otherwise), and
 * the give-up "parked" terminal state for streams pointed at dead sandboxes
 * (see `maxConsecutiveHardFailures`/`onParked`).
 */

import type { Event as OpenCodeSdkEvent } from '../runtime/runtime-types';
import { getSupabaseAccessToken, invalidateTokenCache } from '../http/auth';
import { getClientForUrl } from '../runtime/client';
import { isAuthFailure } from '../http/api/errors';
import { logger } from '../http/logger';

/**
 * The event union this stream dispatches. Re-exported (unchanged shape) from
 * `react/use-opencode-events/types.ts` so existing importers keep working —
 * this module is now the canonical definition.
 */
export type RuntimeEvent =
  | OpenCodeSdkEvent
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
      sseMaxRetryAttempts?: number;
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
  /** Uniform `[0, 1)`; spreads reconnect delays. Defaults to `() => 0` (no
   *  jitter) when omitted, so a fake clock stays exact. */
  random?: () => number;
}

const realTimers: EventStreamTimers = {
  now: () => Date.now(),
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle),
  random: () => Math.random(),
};

export interface OpenEventStreamOptions {
  /** The session runtime to stream from: `${backendUrl}/p/{externalId}/{port}`
   *  (a session handle's `runtimeUrl`). Streams to one URL share one connection. */
  url?: string;
  /**
   * A runtime client to stream from, instead of `url`.
   * @deprecated Pass `url`. Removed in the next major.
   */
  client?: EventStreamClient;
  /** Called once per event, in dispatch order, after coalescing/flush. A
   *  throw here is caught and logged — one bad handler must never break the
   *  stream or crash the host.
   *
   *  Consecutive `message.part.delta` events of one part field that land in
   *  the same 16ms flush arrive as ONE event: `properties.delta` is their
   *  text joined, `id` is the last one's, and `coalesced` lists the wire
   *  events it replaced. Appending `delta` gives the same text either way. */
  onEvent: (event: RuntimeEvent) => void;
  /** Called once a reconnect is ESTABLISHED, with the gap in ms from the last
   *  frame received to the new connection. Fires when the dropped stream had
   *  delivered events, or when the gap exceeds 5s. Lets the host re-hydrate
   *  anything it fears went stale (e.g. replay messages for busy sessions) —
   *  the machine itself holds no host state to re-hydrate. */
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
   * declares it dead, aborts it, and reconnects. Defaults to 60s: three of the
   * sandbox daemon's 20 s keepalive frames. See the `HEARTBEAT_MS` comment.
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
  /**
   * The connection's state, for a host indicator: `connecting` when an attempt
   * starts, `open` on the attempt's first frame, `lost` when it drops and a
   * retry is scheduled. A park reports through `onParked`, a `close()` reports
   * nothing. A subscriber that joins a live stream is told its current state.
   */
  onConnectionChange?: (state: EventStreamConnectionState) => void;
  /** Test-only clock/timer override. Defaults to real `Date.now`/`setTimeout`. */
  timers?: EventStreamTimers;
}

/** See {@link OpenEventStreamOptions.onConnectionChange}. */
export type EventStreamConnectionState = 'connecting' | 'open' | 'lost';

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
const HEARTBEAT_MS = 60_000;
const GAP_REHYDRATE_MS = 5_000;
const FAST_RECONNECT_DELAY_MS = 250;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_BACKOFF_EXPONENT = 5;
/** A worked stream that closes sooner than this is not "stable"... */
const STABLE_LIFETIME_MS = 10_000;
/** ...and this many of them in a row drop the fast path (a server that sends
 *  one frame and closes would otherwise reconnect 4 times a second). */
const MAX_CONSECUTIVE_SHORT_STABLE = 4;
/** Reconnect delays stretch by up to this fraction, so a restart does not
 *  bring every client back in lockstep. */
const RECONNECT_JITTER = 0.5;
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

type PartDeltaEvent = Extract<RuntimeEvent, { type: 'message.part.delta' }> & {
  /** The wire events this one replaced, in order. Set only on a merged event. */
  coalesced?: RuntimeEvent[];
};

/**
 * Text-delta coalescing: `next` appended to `tail` as ONE event, when both are
 * deltas of the same part field. Else undefined.
 *
 * Only the queue's TAIL is ever merged into, so a run never crosses another
 * event and dispatch order stays the wire order. The merged event carries the
 * joined `delta`, the last wire event's `id`, and every wire event it replaced
 * in `coalesced`: a consumer that dedupes by event id (the sync store) still
 * sees each one.
 */
function mergePartDelta(tail: RuntimeEvent | undefined, next: RuntimeEvent): RuntimeEvent | undefined {
  if (tail?.type !== 'message.part.delta' || next.type !== 'message.part.delta') return undefined;
  const a = tail.properties;
  const b = next.properties;
  if (
    a.partID !== b.partID ||
    a.field !== b.field ||
    a.messageID !== b.messageID ||
    a.sessionID !== b.sessionID
  ) {
    return undefined;
  }
  // The list is this module's own (made on a run's first merge), so it grows in place.
  const wire = (tail as PartDeltaEvent).coalesced ?? [tail];
  wire.push(next);
  return { ...next, properties: { ...b, delta: a.delta + b.delta }, coalesced: wire } as PartDeltaEvent;
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

/** One `openEventStream()` caller's callbacks, held by the shared connection
 *  for the lifetime of its subscription — see `LiveStream` below. */
interface StreamSubscriber {
  onEvent: (event: RuntimeEvent) => void;
  onGapRehydrate?: (gapMs: number) => void;
  onParked?: (reason: EventStreamParkedInfo) => void;
  onConnectionChange?: (state: EventStreamConnectionState) => void;
}

/** The shared underlying connection for one client — see `liveStreamsByClient`. */
interface LiveStream {
  subscribers: Set<StreamSubscriber>;
  /** The connection's last reported state; null once parked or torn down. */
  connectionState: () => EventStreamConnectionState | null;
  /** True once the connect loop gave up. A parked stream never reconnects, so
   *  a later `openEventStream` replaces it instead of joining it. */
  isParked: () => boolean;
  /** Aborts the connection and releases its timers. Called once, when the
   *  LAST subscriber leaves. */
  teardown: () => void;
}

/**
 * Fans out ONE live SSE connection per client to every open subscriber — see
 * the shared-stream fan-out invariant documented on `openEventStream` below.
 *
 * Keyed by `EventStreamClient` object identity. `getClientForUrl`
 * (`core/runtime/client.ts`) caches exactly one client per resolved runtime
 * URL, so every `openEventStream()` call targeting the SAME runtime (the
 * same sandbox, the same OpenCode session) is handed the identical client
 * reference, and every call for a DIFFERENT runtime gets a different one.
 * That makes the client itself the natural "scope" key — no caller has to
 * mint or thread an explicit session/scope id, and two genuinely unrelated
 * streams (different sandboxes) never collide.
 *
 * `WeakMap` so a client that falls out of scope (its sandbox torn down, no
 * live handle referencing it) is never pinned by this module.
 */
const liveStreamsByClient = new WeakMap<EventStreamClient, LiveStream>();

/**
 * Opens (or joins) the underlying connect/reconnect loop for `client` and
 * fans its events out to every subscriber in `subscribers`. Only ever called
 * once per client, by whichever `openEventStream()` call finds no existing
 * `LiveStream` — every later caller for the same client joins the SAME
 * `LiveStream` instead (see `openEventStream`). The FIRST caller's `opts`
 * (timers, connect/heartbeat timeouts, `maxConsecutiveHardFailures`) govern
 * the shared connection for its whole lifetime; a later joiner's values for
 * those fields are not consulted — there is only one wire connection to
 * configure, and re-configuring it mid-flight for a joiner would be
 * ambiguous. Every subscriber's `onEvent`/`onGapRehydrate`/`onParked` is
 * still called independently, in full.
 */
function createLiveStream(
  client: EventStreamClient,
  opts: OpenEventStreamOptions,
  subscribers: Set<StreamSubscriber>,
): LiveStream {
  const t = opts.timers ?? realTimers;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_MS;
  const maxConsecutiveHardFailures =
    opts.maxConsecutiveHardFailures ?? MAX_CONSECUTIVE_HARD_FAILURES;

  const abortController = new AbortController();

  /** Calls `fn` on every current subscriber. A throwing subscriber must
   *  never break dispatch to the others or crash the host. */
  function dispatchToSubscribers<A extends unknown[]>(
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

  let connectionState: EventStreamConnectionState | null = null;
  let parked = false;
  const setConnectionState = (state: EventStreamConnectionState | null) => {
    if (connectionState === state) return;
    connectionState = state;
    if (state) dispatchToSubscribers((sub) => sub.onConnectionChange, state);
  };

  // Track last stream activity (connect or event) to gate reconnect hydration.
  // Using only "last event" causes hydrate storms when the server rotates
  // idle SSE connections that carried no events.
  let lastStreamActivityTime = t.now();

  // A drop that has not been repaired yet. `/global/event` has no replay, so
  // frames emitted between the drop and the next connection are lost. The
  // repair (`onGapRehydrate`) runs once the NEXT connection is established:
  // a re-list issued before that could miss frames emitted before the new
  // stream subscribes. Survives failed attempts, so a run of failed connects
  // still ends in exactly one rehydrate.
  let pendingGap: { lastActivityAt: number; eventful: boolean } | null = null;

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
      // A single subscriber's handler must never break the stream OR crash
      // the host, and must never stop the OTHER subscribers from receiving
      // this event — `dispatchToSubscribers` catches per-subscriber. e.g. a
      // handler calls getClient() before the sandbox URL is pinned (during a
      // session switch) — that throw used to escape to the route error
      // boundary. Swallow + log; the next events + retries recover.
      dispatchToSubscribers((sub) => sub.onEvent, item.event);
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
    let consecutiveShortStable = 0;
    while (!abortController.signal.aborted) {
      // Events other than the connection's own `server.connected` greeting.
      let streamHadWork = false;
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
      setConnectionState('connecting');
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
        const { stream } = result;

        // Repair the previous drop now that a live stream exists. The gap runs
        // from the last frame received to this connection. A dropped stream
        // that was delivering events always repairs — its outage window may
        // have held any frame. An idle one repairs only past 5s, so routine
        // idle rotation does not re-read every transcript.
        if (pendingGap) {
          const gap = t.now() - pendingGap.lastActivityAt;
          const eventful = pendingGap.eventful;
          pendingGap = null;
          if (eventful || gap > GAP_REHYDRATE_MS) {
            dispatchToSubscribers((sub) => sub.onGapRehydrate, gap);
          }
        }
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

          setConnectionState('open');
          resetHeartbeat();
          const raw = outcome.result.value as any;
          const e = (
            raw && typeof raw === 'object' && 'payload' in raw ? raw.payload : raw
          ) as RuntimeEvent;
          if (!e?.type) continue;
          // The connection's own greeting is not work that a drop could lose.
          if (e.type !== 'server.connected') streamHadWork = true;

          // The tail is never a replaced slot: a replacement pushes right after.
          const merged = mergePartDelta(queue[queue.length - 1]?.event, e);
          if (merged) {
            queue[queue.length - 1] = { type: merged.type, event: merged };
          } else {
            const ck = getCoalesceKey(e);
            if (ck) {
              const existing = coalesced.get(ck);
              if (existing !== undefined) {
                queue[existing] = undefined;
              }
              coalesced.set(ck, queue.length);
            }
            queue.push({ type: (e as any).type, event: e });
          }
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
        stableConnection = streamHadWork;
      } catch (err) {
        if (abortController.signal.aborted) break;
        attemptError = err;
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
      // either carried an HTTP-level status (the vendor client wraps non-2xx
      // as `Error` with `cause: { status }` — see @opencode-ai/sdk's
      // error-interceptor) or died within HARD_FAILURE_WINDOW_MS (edge 503s
      // surface as opaque network/CORS errors with no status attached).
      // Slow failures without a status (a black-holed connect that hit the
      // 20s connect timeout) and anything that streamed a real event reset
      // the streak. After `maxConsecutiveHardFailures` in a row — spread
      // over ~2 minutes by the exponential backoff below — park for good.
      const attemptDurationMs = t.now() - attemptStartedAt;
      const httpStatus = (attemptError as { cause?: { status?: unknown } } | null)?.cause?.status;
      // A greeting alone is not delivery: a proxy that says hello and closes
      // is as dead as one that refuses the connect.
      const isHardFailure =
        !streamHadWork &&
        ((typeof httpStatus === 'number' && httpStatus >= 400) ||
          attemptDurationMs < HARD_FAILURE_WINDOW_MS);
      consecutiveHardFailures = isHardFailure ? consecutiveHardFailures + 1 : 0;
      if (consecutiveHardFailures >= maxConsecutiveHardFailures) {
        logger.error('SSE event stream parked — giving up after consecutive hard failures', {
          consecutiveFailures: consecutiveHardFailures,
          lastError: String(attemptError),
        });
        // A subscriber's park handler must never crash the (already-
        // terminal) stream machine, and must never stop another
        // subscriber's from firing — `dispatchToSubscribers` catches per
        // subscriber.
        connectionState = null;
        parked = true;
        dispatchToSubscribers((sub) => sub.onParked, {
          consecutiveFailures: consecutiveHardFailures,
          lastError: attemptError,
        });
        break;
      }
      setConnectionState('lost');

      // Record the drop. Events missed while no connection exists (e.g. a
      // streaming assistant response, a permission ask) never arrive, so the
      // host re-hydrates once the next connection is up (see `pendingGap`).
      // A drop that is still unrepaired (a failed reconnect) keeps its start.
      const unrepaired = pendingGap as { lastActivityAt: number; eventful: boolean } | null;
      pendingGap = {
        lastActivityAt: lastStreamActivityTime,
        eventful: (unrepaired?.eventful ?? false) || streamHadWork,
      };

      consecutiveShortStable =
        stableConnection && attemptDurationMs < STABLE_LIFETIME_MS ? consecutiveShortStable + 1 : 0;
      const fastPath = stableConnection && consecutiveShortStable <= MAX_CONSECUTIVE_SHORT_STABLE;
      if (fastPath) {
        // Fast reconnect after healthy streams so live streaming resumes
        // immediately.
        retryCount = 0;
      } else {
        retryCount++;
        if (retryCount > 1) {
          logger.warn('SSE event stream reconnecting', { retryCount });
        }
      }
      const baseDelay = fastPath
        ? FAST_RECONNECT_DELAY_MS
        : Math.min(
            BASE_RECONNECT_DELAY_MS * 2 ** Math.min(retryCount - 1, MAX_BACKOFF_EXPONENT),
            MAX_RECONNECT_DELAY_MS,
          );
      const delay = Math.round(baseDelay * (1 + RECONNECT_JITTER * (t.random?.() ?? 0)));
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
    subscribers,
    connectionState: () => connectionState,
    isParked: () => parked,
    teardown: () => {
      connectionState = null;
      abortController.abort();
      if (flushTimer) t.clearTimeout(flushTimer);
    },
  };
}

/**
 * Connects to the opencode SSE event stream and keeps it alive: heartbeat
 * watchdog, event coalescing + batched flush, gap-triggered rehydrate signal,
 * and exponential-backoff reconnect. Framework-free — safe to call from any
 * host (the React wrapper calls this once per effect run; a non-React host can
 * call it directly).
 *
 * **Shared-stream fan-out.** A second concurrent open for a client that
 * already has a live stream (see `liveStreamsByClient`) does NOT tear the
 * first one down — it SHARES it. Realistic sources of a stacked open:
 * a second mounted subscriber opening its own stream for the same runtime
 * without closing an existing one (e.g. an out-of-order remount), or a
 * programmatic consumer that opens more than one handle for the same
 * runtime on purpose. Each `openEventStream()` call gets its own
 * independent `EventStreamHandle`; `close()` decrements a refcount on the
 * shared connection, and the underlying connection (and its timers) tears
 * down only once the LAST subscriber closes. Every subscriber's
 * `onEvent`/`onGapRehydrate`/`onParked` still fires for every event —
 * exactly once each, off the single underlying wire connection, so no
 * subscriber has to be idempotent against a duplicate delivery the way
 * `sync-store.ts`'s `applyPartDelta` separately guards against.
 *
 * Only the FIRST caller's `connectTimeoutMs`/`heartbeatTimeoutMs`/
 * `maxConsecutiveHardFailures`/`timers` govern the shared connection — a
 * later joiner's values for those fields are not consulted (see
 * `createLiveStream`'s doc comment). `signal` is per-subscriber: aborting a
 * caller's own signal only closes THAT caller's handle, not the shared
 * connection (unless it was the last one standing).
 */
export function openEventStream(opts: OpenEventStreamOptions): EventStreamHandle {
  const { onEvent, onGapRehydrate, onParked, onConnectionChange, signal: externalSignal } = opts;
  const client: EventStreamClient | undefined = opts.client ?? (opts.url ? getClientForUrl(opts.url) : undefined);
  if (!client) throw new Error('openEventStream needs the session runtime `url`');
  const subscriber: StreamSubscriber = { onEvent, onGapRehydrate, onParked, onConnectionChange };

  let liveStream = liveStreamsByClient.get(client);
  // A parked stream has no connect loop left. Joining it would hand this caller
  // a stream that never delivers and never says so, and would make a revival's
  // fresh open join the corpse too. Replace it: its old subscribers keep their
  // handles, and their `leave` only deletes the registry entry it still owns.
  if (liveStream?.isParked()) {
    liveStreamsByClient.delete(client);
    liveStream = undefined;
  }
  if (!liveStream) {
    const subscribers = new Set<StreamSubscriber>([subscriber]);
    liveStream = createLiveStream(client, opts, subscribers);
    liveStreamsByClient.set(client, liveStream);
  } else {
    liveStream.subscribers.add(subscriber);
    const state = liveStream.connectionState();
    if (state) onConnectionChange?.(state);
  }
  const stream = liveStream;

  let closed = false;
  const leave = () => {
    if (closed) return;
    closed = true;
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    stream.subscribers.delete(subscriber);
    if (stream.subscribers.size === 0) {
      stream.teardown();
      // Only clear the registry if this stream is STILL the registered live
      // stream for this client — defensive, though under refcounting a
      // newer stream can never exist for a client while an older one still
      // has this client mapped (a fresh `LiveStream` for the same client is
      // only ever created after `liveStreamsByClient.get(client)` reports
      // none live).
      if (liveStreamsByClient.get(client) === stream) liveStreamsByClient.delete(client);
    }
  };
  const onExternalAbort = () => leave();
  if (externalSignal) {
    if (externalSignal.aborted) leave();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return { close: leave };
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

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `RuntimeEvent`. Removed in the next major. */
export type OpenCodeEvent = RuntimeEvent;
