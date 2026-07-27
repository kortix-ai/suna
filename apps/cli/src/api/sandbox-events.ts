/**
 * Server-Sent Events transport for a sandbox's OpenCode event bus — the ONLY
 * file in the CLI that speaks HTTP to `/global/event`.
 *
 * WHY THIS IS A PORT AND NOT AN IMPORT
 * `packages/sdk` already ships the production version of this machine
 * (`core/stream/event-stream.ts`), and every constant below is copied from it
 * unchanged. It is not imported because `@kortix/sdk` drags in `zustand`, a
 * React peer, and `@opencode-ai/sdk` — and `apps/cli/scripts/build.sh` compiles
 * this CLI with `bun build --compile` into a single binary that is baked into
 * every sandbox image. The CLI's dependency list is deliberately six workspace
 * packages and two libraries; ~200 lines here is cheaper than that graph.
 *
 * WHAT THE WIRE LOOKS LIKE
 * `GET /v1/p/<external-id>/<port>/global/event` with `Authorization: Bearer`
 * and `Accept: text/event-stream`. Frames are `data: <json>` blocks separated
 * by a blank line. The JSON is OpenCode's `GlobalEvent`
 * (`{ directory, payload: { type, properties } }`), but a raw stream may emit
 * the bare `{ type, properties }` instead — both shapes are accepted here, the
 * same hedge the SDK makes (event-stream.ts unwraps `payload` if present) and
 * the mobile client makes (apps/mobile/lib/opencode/event-stream.ts).
 *
 * WHAT SSE DOES NOT GIVE YOU — all three are why this file is 200 lines and
 * not 20:
 *   1. No keepalive frames. A healthy-but-quiet session is genuinely silent
 *      for minutes, so the idle watchdog has to be generous (60s).
 *   2. Streams are severed routinely. `apps/api/src/index.ts` classifies a
 *      504/502/503 on `/global/event` as EXPECTED proxy noise. Reconnect —
 *      and, past a 5s gap, tell the host to reconcile, because the events
 *      emitted during the gap are gone forever.
 *   3. A dead sandbox 503s every connect, forever. Hence the park.
 */

import type { Auth } from './auth.ts';

// ── Tunables — copied from packages/sdk/src/core/stream/event-stream.ts ─────
// Each one encodes a production incident; do not "tidy" them.

/** Coalescing window before dispatching a batch of events to the host. */
const COALESCE_FLUSH_MS = 16;
/**
 * Idle watchdog for an ESTABLISHED stream. The server emits NO keepalive
 * frames, so a quiet session produces genuinely long silent stretches — the
 * old 15s value guaranteed a reconnect every 15s of quiet, by design. 60s
 * still catches a dead socket while tolerating normal idle.
 */
const HEARTBEAT_MS = 60_000;
/**
 * A reconnect that follows a gap this large means events were emitted while we
 * were disconnected and are gone for good. The host must re-read history and
 * reconcile, or it silently drops the middle of a turn.
 */
const GAP_REHYDRATE_MS = 5_000;
/** Resume immediately after a stream that actually delivered events. */
const FAST_RECONNECT_DELAY_MS = 250;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_BACKOFF_EXPONENT = 5;
/**
 * Guards a black-holed proxy that swallows the connect with no error, no data
 * and no close. The heartbeat cannot help: it only starts once connect
 * resolves.
 */
const CONNECT_TIMEOUT_MS = 20_000;
/** An event-less attempt that dies faster than this is the fast-503 signature
 *  of a dead sandbox, even when the error carries no HTTP status. */
const HARD_FAILURE_WINDOW_MS = 2_000;
/** Combined with the exponential backoff this spreads the give-up over roughly
 *  two minutes, then parks for good rather than 503-looping forever. */
const MAX_CONSECUTIVE_HARD_FAILURES = 8;

/** A raw OpenCode bus event, before chat-narrowing. */
export interface SandboxEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export type EventStreamTimerHandle = ReturnType<typeof setTimeout>;

/** Injectable clock so tests drive reconnect/backoff/heartbeat deterministically
 *  instead of paying real wall-clock delays. Same seam the SDK exposes. */
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

export interface SandboxEventStreamParkedInfo {
  consecutiveFailures: number;
  lastError: unknown;
}

export interface SandboxEventStreamOptions {
  auth: Pick<Auth, 'api_base' | 'token'>;
  /** The sandbox's external/provider id — the `/v1/p/{proxyId}/…` proxy key. */
  proxyId: string;
  /** Sandbox daemon/runtime port. */
  port: number;
  /** One call per event, in order, after the coalescing flush. A throw here is
   *  caught — one bad handler must never kill the stream. */
  onEvent: (event: SandboxEvent) => void;
  /** Fired when a reconnect follows a gap > 5s, with the gap in ms. */
  onGapRehydrate?: (gapMs: number) => void;
  /** Fired on every successful connect (including reconnects). */
  onConnected?: () => void;
  /** Fired when an attempt dies and another is scheduled, with the delay. */
  onReconnecting?: (delayMs: number) => void;
  /** Fired ONCE when the stream gives up. Terminal for this handle. */
  onParked?: (info: SandboxEventStreamParkedInfo) => void;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  maxConsecutiveHardFailures?: number;
  timers?: EventStreamTimers;
  /** Test seam. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface SandboxEventStreamHandle {
  /** Aborts the in-flight connection, stops all reconnect activity, drops the
   *  pending flush. Idempotent — safe on an already-parked stream. */
  close: () => void;
}

/** Same URL shape `sandboxRequest` builds (`joinProxyUrl`), so the stream and
 *  every other proxy call agree on the base. */
export function sandboxEventUrl(apiBase: string, proxyId: string, port: number): string {
  return `${apiBase.replace(/\/+$/, '')}/v1/p/${encodeURIComponent(proxyId)}/${port}/global/event`;
}

/**
 * Split a decoded buffer into complete SSE frames plus the unterminated
 * remainder. Frames are separated by a blank line; both LF and CRLF line
 * endings appear in the wild depending on which proxy hop rewrote the body.
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts.filter((f) => f.trim().length > 0), rest };
}

/**
 * Turn one SSE frame into an event, or null when it carries nothing usable.
 *
 * Joins multi-line `data:` fields with newlines (per the SSE spec — a large
 * JSON payload can legally be split across several `data:` lines), skips `:`
 * comments and `event:`/`id:`/`retry:` fields, and unwraps `payload` so both
 * the `GlobalEvent` wrapper and a bare event body work.
 */
export function parseSseFrame(frame: string): SandboxEvent | null {
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // A single leading space after the colon is part of the framing, not data.
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  }
  if (data.length === 0) return null;
  const raw = data.join('\n');
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const unwrapped =
    parsed && typeof parsed === 'object' && 'payload' in (parsed as Record<string, unknown>)
      ? (parsed as { payload: unknown }).payload
      : parsed;
  if (!unwrapped || typeof unwrapped !== 'object') return null;
  const event = unwrapped as SandboxEvent;
  return typeof event.type === 'string' ? event : null;
}

/**
 * Connect to the sandbox's SSE bus and keep it alive: connect timeout,
 * heartbeat watchdog, 16ms coalesced dispatch, gap-triggered rehydrate signal,
 * exponential-backoff reconnect, and the parked terminal state.
 */
export function openSessionEventStream(
  opts: SandboxEventStreamOptions,
): SandboxEventStreamHandle {
  const t = opts.timers ?? realTimers;
  const doFetch = opts.fetchImpl ?? fetch;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_MS;
  const maxHardFailures = opts.maxConsecutiveHardFailures ?? MAX_CONSECUTIVE_HARD_FAILURES;
  const url = sandboxEventUrl(opts.auth.api_base, opts.proxyId, opts.port);

  const outer = new AbortController();
  const onExternalAbort = () => outer.abort();
  if (opts.signal) {
    if (opts.signal.aborted) outer.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Connect OR event — both count as activity. Using only "last event" makes
  // every rotation of an idle connection look like a gap and triggers a
  // rehydrate storm.
  let lastStreamActivityTime = t.now();
  let queue: SandboxEvent[] = [];
  let flushTimer: EventStreamTimerHandle | undefined;
  let lastFlush = 0;

  const flush = (): void => {
    t.clearTimeout(flushTimer);
    flushTimer = undefined;
    if (queue.length === 0) return;
    const events = queue;
    queue = [];
    lastFlush = t.now();
    lastStreamActivityTime = t.now();
    for (const event of events) {
      try {
        opts.onEvent(event);
      } catch {
        // One handler throwing must never break the stream or crash the CLI.
      }
    }
  };

  const schedule = (): void => {
    if (flushTimer) return;
    const elapsed = t.now() - lastFlush;
    flushTimer = t.setTimeout(flush, Math.max(0, COALESCE_FLUSH_MS - elapsed));
  };

  void (async () => {
    let retryCount = 0;
    let consecutiveHardFailures = 0;

    while (!outer.signal.aborted) {
      let streamHadEvents = false;
      let httpStatus: number | null = null;
      let attemptError: unknown = null;
      const attemptStartedAt = t.now();
      // Per-attempt controller: aborting it is what actually cancels the
      // network read. It fires when the heartbeat/connect watchdog trips OR
      // when the outer handle closes.
      const attempt = new AbortController();
      const linkAbort = () => attempt.abort();
      outer.signal.addEventListener('abort', linkAbort, { once: true });
      let heartbeatTimer: EventStreamTimerHandle | undefined;
      let connectTimer: EventStreamTimerHandle | undefined;

      try {
        connectTimer = t.setTimeout(() => attempt.abort(), connectTimeoutMs);
        const res = await doFetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${opts.auth.token}`,
            // The API's request-deadline middleware exempts a request from the
            // global timeout on this header alone, so it is load-bearing, not
            // cosmetic.
            Accept: 'text/event-stream',
            'User-Agent': `kortix-cli/${process.env.KORTIX_CLI_VERSION ?? 'dev'}`,
          },
          signal: attempt.signal,
        });
        t.clearTimeout(connectTimer);
        connectTimer = undefined;

        if (!res.ok || !res.body) {
          httpStatus = res.status;
          throw new Error(`event stream failed: HTTP ${res.status}`);
        }

        lastStreamActivityTime = t.now();
        opts.onConnected?.();

        const resetHeartbeat = (): void => {
          t.clearTimeout(heartbeatTimer);
          heartbeatTimer = t.setTimeout(() => attempt.abort(), heartbeatTimeoutMs);
        };
        resetHeartbeat();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          resetHeartbeat();
          buffer += decoder.decode(value, { stream: true });
          const split = splitSseFrames(buffer);
          buffer = split.rest;
          for (const frame of split.frames) {
            const event = parseSseFrame(frame);
            if (!event) continue;
            streamHadEvents = true;
            queue.push(event);
            schedule();
          }
        }
      } catch (err) {
        if (outer.signal.aborted) break;
        attemptError = err;
      } finally {
        t.clearTimeout(heartbeatTimer);
        t.clearTimeout(connectTimer);
        attempt.abort();
        outer.signal.removeEventListener('abort', linkAbort);
        flush();
      }

      if (outer.signal.aborted) break;

      // ── Park check — the dead-sandbox terminal state. ────────────────────
      // A hard failure delivered zero events AND either carried an HTTP status
      // or died inside the fast-503 window. A slow failure with no status (a
      // black-holed connect that hit the connect timeout) resets the streak,
      // because that is a network problem, not a gone sandbox.
      const attemptDurationMs = t.now() - attemptStartedAt;
      const isHardFailure =
        !streamHadEvents &&
        ((httpStatus !== null && httpStatus >= 400) || attemptDurationMs < HARD_FAILURE_WINDOW_MS);
      consecutiveHardFailures = isHardFailure ? consecutiveHardFailures + 1 : 0;
      if (consecutiveHardFailures >= maxHardFailures) {
        try {
          opts.onParked?.({
            consecutiveFailures: consecutiveHardFailures,
            lastError: attemptError,
          });
        } catch {
          // A park handler must never crash the already-terminal machine.
        }
        break;
      }

      const gap = t.now() - lastStreamActivityTime;
      if (gap > GAP_REHYDRATE_MS) opts.onGapRehydrate?.(gap);

      // An idle disconnect must ride the exponential backoff. Treating "stayed
      // open a while" as healthy locked the web client into a 250ms reconnect
      // loop in production (~236 reconnects/hour/stream).
      const stableConnection = streamHadEvents;
      if (stableConnection) retryCount = 0;
      else retryCount += 1;
      const delay = stableConnection
        ? FAST_RECONNECT_DELAY_MS
        : Math.min(
            BASE_RECONNECT_DELAY_MS * 2 ** Math.min(retryCount - 1, MAX_BACKOFF_EXPONENT),
            MAX_RECONNECT_DELAY_MS,
          );
      opts.onReconnecting?.(delay);
      await new Promise<void>((resolve) => {
        const timer = t.setTimeout(resolve, delay);
        outer.signal.addEventListener(
          'abort',
          () => {
            t.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  })();

  return {
    close: () => {
      outer.abort();
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
      t.clearTimeout(flushTimer);
      flushTimer = undefined;
    },
  };
}
