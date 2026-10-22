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

import {
  CONNECT_TIMEOUT_MS,
  HEARTBEAT_MS,
  MAX_CONSECUTIVE_HARD_FAILURES,
  abortableDelay,
  connectAttempt,
  createEventCoalescer,
  dispatchToStreamSubscribers,
  isHardAttemptFailure,
  parkStream,
  reconnectDelay,
} from './event-attempt';
import type { Event as OpenCodeSdkEvent } from '../runtime/runtime-types';
import { getClientForUrl } from '../runtime/client';
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
   *  Consecutive `message.part.delta` events of one part field (or
   *  `log.block.delta` events of one session-log block) that land in
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

const GAP_REHYDRATE_MS = 5_000;
/** A worked stream that closes sooner than this is not "stable"... */
const STABLE_LIFETIME_MS = 10_000;
/** ...and this many of them in a row drop the fast path (a server that sends
 *  one frame and closes would otherwise reconnect 4 times a second). */
const MAX_CONSECUTIVE_SHORT_STABLE = 4;

/** One `openEventStream()` caller's callbacks, held by the shared connection
 *  for the lifetime of its subscription — see `LiveStream` below. */
export interface StreamSubscriber {
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
  const dispatchToSubscribers = <A extends unknown[]>(
    pick: (sub: StreamSubscriber) => ((...a: A) => void) | undefined,
    ...args: A
  ): void => dispatchToStreamSubscribers(subscribers, pick, ...args);

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

  const coalescer = createEventCoalescer(t, (event) => {
    // A flush that delivered events is stream activity: the gap clock
    // restarts here (see `pendingGap`).
    lastStreamActivityTime = t.now();
    dispatchToSubscribers((sub) => sub.onEvent, event);
  });

  const attemptDeps = {
    client,
    t,
    connectTimeoutMs,
    heartbeatTimeoutMs,
    outerSignal: abortController.signal,
    setConnectionState,
    onConnected: () => {
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
    },
    coalescer,
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
      const attemptStartedAt = t.now();
      const outcome = await connectAttempt({ ...attemptDeps, retryCount });
      if (abortController.signal.aborted) break;
      const attemptError = outcome.error;
      const { streamHadWork, stableConnection } = outcome;

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
      const isHardFailure = isHardAttemptFailure(streamHadWork, attemptError, attemptDurationMs);
      consecutiveHardFailures = isHardFailure ? consecutiveHardFailures + 1 : 0;
      if (consecutiveHardFailures >= maxConsecutiveHardFailures) {
        parkStream(subscribers, consecutiveHardFailures, attemptError);
        connectionState = null;
        parked = true;
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
      await abortableDelay(t, abortController.signal, reconnectDelay(retryCount, fastPath, t));
    }
  })();
  return {
    subscribers,
    connectionState: () => connectionState,
    isParked: () => parked,
    teardown: () => {
      connectionState = null;
      abortController.abort();
      coalescer.clearTimer();
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
