/**
 * ONE live connection per session: `GET .../sessions/:sid/events` (R5.3).
 *
 * The API multiplexes two sources onto it:
 *  - the `control` channel: the API's own snapshots (`kortix.control.*`): the
 *    prompt queue, the turn verdict with the server's `working` state, the box
 *    and wake ladder, the title, the mirror and audit watermarks, and the
 *    runtime projection (pending permissions and questions);
 *  - the `runtime` channel: the box's sequenced events, forwarded verbatim,
 *    plus the stream's own `kortix.runtime.status` and `kortix.runtime.health`.
 *
 * Before R5 a session view held a second connection through the sandbox proxy
 * to `/global/event` and polled `/turn`, `/prompts`, `/start`, `/kortix/health`,
 * `/permission`, `/question` and the title on their own clocks. Now every
 * caller joins this one connection, and the polls stand down while it is up.
 *
 * Sharing: one connection per session per client, however many callers open
 * it. A caller that wants the runtime channel (`runtime: true`) upgrades the
 * shared connection from `?channels=control` to every channel; the reconnect
 * keeps both cursors. A caller that joins a live connection is handed the
 * newest frame of each control type at once.
 *
 * Reconnect is a capped backoff that resumes at both cursors: `since_control`
 * + `cepoch` and `since` + `epoch`. A `kortix.control.resync` drops the
 * control cursor (the server then sends every snapshot); a runtime
 * `kortix.resync` drops the runtime cursor and is reported, because the
 * runtime is a log, not a snapshot. Every frame, and the typed
 * `kortix.stream.heartbeat` every 15 s, proves liveness; silence past
 * `livenessMs` ends the connection and reconnects.
 *
 * Framework-free. Auth is the platform seam (`platformEventTransport`).
 */

import { platformConfig } from '../http/config';
import type { SessionPrompt } from '../rest/projects-client/sessions';
import type { RuntimeEvent } from '../stream/event-stream';
import { platformEventTransport } from '../stream/platform-event-transport';
import {
  dispatchFrame,
  each,
  notifyConnectionListeners,
  safely,
  type FrameCursors,
  type SharedStream,
} from './control-stream-frames';

export { subscribeSessionStreamConnections } from './control-stream-frames';

/** The payload of a `kortix.control.queue` frame: the whole inbox. */
export interface SessionControlQueue {
  known: boolean;
  prompts: SessionPrompt[];
  held: boolean;
  /** The server clock when the reconciler asked for this list. */
  observed_at?: string;
}

/** One `kortix.control.*` frame. Each carries its subsystem's whole state. */
export interface SessionControlFrame {
  type: string;
  cseq: number;
  cepoch: string;
  /** Server clock, ms. */
  at: number;
  payload: unknown;
}

/** `kortix.runtime.status`: whether the API is attached to the box. */
export interface SessionRuntimeStatus {
  state: 'up' | 'down';
  /** Why the runtime is down (`sandbox_stopped`, `daemon_503`, ...), else null. */
  reason: string | null;
}

export interface SessionControlStreamTiming {
  /** Reconnect delays in ms; the last one repeats. */
  backoffMs?: readonly number[];
  /** Silence after which a connection is dead. Three server heartbeats. */
  livenessMs?: number;
}

export interface SessionControlStreamOptions {
  projectId: string;
  sessionId: string;
  /** Join the runtime channel too. Upgrades the shared connection. */
  runtime?: boolean;
  /**
   * `'v2'`: the session negotiated the session log. While any subscriber asks for it, a
   * connection with the runtime channel adds `schema=v2`, and a switch either way reconnects at
   * once at the same cursors.
   * - The daemon side is complete (P4.3b): kortixd's `schema=v2` stream carries `log.*` frames in
   *   place of the `message.*` transcript frames, plus every non-transcript frame (`session.*`,
   *   `permission.*`, `question.*`, `todo.*`, ...), and a streaming `log.message` put precedes the
   *   first `log.block.delta` of a message.
   * - The API relay (P4.4) is the remaining prerequisite: until it is on dev the API ignores
   *   `schema`, the runtime channel keeps the v1 frames, and a live turn streams through them.
   */
  schema?: 'v2';
  /**
   * This browser tab's presence id (`PUT .../presence`). The server renews the
   * tab's lease while the stream is open, so the tab sends no presence
   * heartbeat of its own.
   */
  tabId?: string;
  onQueue?: (queue: SessionControlQueue) => void;
  /** Every control frame, in cseq order. */
  onControl?: (frame: SessionControlFrame) => void;
  /** Runtime events (`runtime: true` only), shaped as the runtime's own wire. */
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  onRuntimeStatus?: (status: SessionRuntimeStatus) => void;
  /** The box's `GET /kortix/health` document, pushed by the API on change. */
  onRuntimeHealth?: (health: Record<string, unknown>) => void;
  /** The runtime log could not be replayed: re-read what the view holds. */
  onRuntimeResync?: () => void;
  /** The stream's typed heartbeat (every 15 s). */
  onHeartbeat?: () => void;
  /** `true` on the first frame of a connection, `false` when it drops. */
  onConnectionChange?: (connected: boolean) => void;
  /** Test seam. The first opener of a session sets it. */
  timing?: SessionControlStreamTiming;
}

/** The same options under the name R5.3 gave the one stream. */
export type SessionStreamOptions = SessionControlStreamOptions;

export interface SessionControlStreamHandle {
  connected: () => boolean;
  /** The last queue frame this stream delivered, or null before the first. */
  lastQueue: () => SessionControlQueue | null;
  /** The newest frame of one control type, or null. */
  lastControl: (type: string) => SessionControlFrame | null;
  close: () => void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const LIVENESS_MS = 45_000;

// replica-local: one shared connection per session in this client.
const streams = new Map<string, SharedStream>();

/** Join (or open) the session's stream. `close()` leaves it. */
export function openSessionStream(options: SessionControlStreamOptions): SessionControlStreamHandle {
  const key = `${options.projectId}/${options.sessionId}`;
  let shared = streams.get(key);
  if (!shared) {
    shared = {
      subscribers: new Set(),
      connected: false,
      lastQueue: null,
      latest: new Map(),
      lastStatus: null,
      lastHealth: null,
      runtimeRefs: 0,
      connectedWithRuntime: false,
      logRefs: 0,
      connectedWithLog: false,
      tabId: null,
      authoritative: false,
      reconnectNow: false,
      attempt: null,
      abort: new AbortController(),
    };
    streams.set(key, shared);
  }
  const target = shared;
  const opening = target.subscribers.size === 0 && !target.attempt;
  target.subscribers.add(options);
  // A control-only connection cannot carry the runtime, and one without the
  // tab's presence id cannot renew it: reconnect at once with the new URL. The
  // cursors survive; the backoff does not apply.
  let reconnect = false;
  if (options.runtime) {
    target.runtimeRefs += 1;
    if (!target.connectedWithRuntime) reconnect = true;
  }
  if (options.schema === 'v2') target.logRefs += 1;
  if (target.runtimeRefs > 0 && target.logRefs > 0 && !target.connectedWithLog) reconnect = true;
  if (options.tabId && target.tabId !== options.tabId) {
    target.tabId = options.tabId;
    reconnect = true;
  }
  if (reconnect && !opening && target.attempt) {
    target.reconnectNow = true;
    target.attempt.abort();
  }
  // Started after this subscriber counts, so its first connect has its channels.
  if (opening) void run(options, target);
  if (target.connected) options.onConnectionChange?.(true);
  for (const frame of [...target.latest.values()].sort((a, b) => a.cseq - b.cseq)) {
    safely(() => options.onControl?.(frame));
  }
  if (target.lastQueue) safely(() => options.onQueue?.(target.lastQueue!));
  if (options.runtime && target.lastStatus) safely(() => options.onRuntimeStatus?.(target.lastStatus!));
  if (options.runtime && target.lastHealth) safely(() => options.onRuntimeHealth?.(target.lastHealth!));
  let closed = false;
  return {
    connected: () => target.connected,
    lastQueue: () => target.lastQueue,
    lastControl: (type) => target.latest.get(type) ?? null,
    close: () => {
      if (closed) return;
      closed = true;
      target.subscribers.delete(options);
      if (options.runtime) target.runtimeRefs -= 1;
      if (options.schema === 'v2') target.logRefs -= 1;
      if (target.subscribers.size > 0) {
        // The last v2 subscriber left: back to the v1 transcript frames.
        if (target.connectedWithLog && (target.logRefs === 0 || target.runtimeRefs === 0) && target.attempt) {
          target.reconnectNow = true;
          target.attempt.abort();
        }
        return;
      }
      target.abort.abort();
      if (streams.get(key) === target) streams.delete(key);
      if (target.connected) {
        target.connected = false;
        notifyConnectionListeners();
      }
    },
  };
}

/** Join the session's stream for its control channel (the prompt queue). */
export const openSessionControlStream = openSessionStream;

/**
 * Is this session's stream connected to a server that owns session state? The
 * SDK stands its polls down on this, never on a bare connection: an API from
 * before R5 serves the stream without the turn verdict, title or health frames.
 */
export function sessionStreamConnected(projectId: string, sessionId: string): boolean {
  const shared = streams.get(`${projectId}/${sessionId}`);
  return shared?.connected === true && shared.authoritative;
}

// replica-local: listeners in this client, told when any stream connects or drops.
function setConnected(shared: SharedStream, connected: boolean): void {
  if (shared.connected === connected) return;
  shared.connected = connected;
  each(shared, (subscriber) => subscriber.onConnectionChange?.(connected));
  notifyConnectionListeners();
}

async function run(options: SessionControlStreamOptions, shared: SharedStream): Promise<void> {
  const backoff = options.timing?.backoffMs ?? BACKOFF_MS;
  const livenessMs = options.timing?.livenessMs ?? LIVENESS_MS;
  const stop = shared.abort.signal;
  const cursors: FrameCursors = { seq: null, epoch: null, cseq: null, cepoch: null };
  let failures = 0;

  while (!stop.aborted) {
    const attempt = new AbortController();
    shared.attempt = attempt;
    const end = () => attempt.abort();
    stop.addEventListener('abort', end);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(end, livenessMs);
    };
    arm();
    // Read at connect time: a runtime subscriber that joins later upgrades.
    const withRuntime = shared.runtimeRefs > 0;
    shared.connectedWithRuntime = withRuntime;
    // The runtime cursor carries across a dialect switch. An API that ignores `schema` resumes
    // the same log with nothing lost; one that serves the v2 log under its own epoch answers the
    // stale cursor with `kortix.resync`, and the view re-reads (`onRuntimeResync`).
    const withLog = withRuntime && shared.logRefs > 0;
    shared.connectedWithLog = withLog;
    try {
      const url = new URL(
        `${platformConfig().backendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(options.projectId)}/sessions/${encodeURIComponent(options.sessionId)}/events`,
      );
      if (!withRuntime) url.searchParams.set('channels', 'control');
      if (withLog) url.searchParams.set('schema', 'v2');
      if (shared.tabId) url.searchParams.set('tab_id', shared.tabId);
      if (withRuntime && cursors.seq !== null && cursors.epoch) {
        url.searchParams.set('since', String(cursors.seq));
        url.searchParams.set('epoch', cursors.epoch);
      }
      if (cursors.cseq !== null && cursors.cepoch) {
        url.searchParams.set('since_control', String(cursors.cseq));
        url.searchParams.set('cepoch', cursors.cepoch);
      }
      const messages = platformEventTransport({
        url: url.href,
        headers: new Headers({ Accept: 'text/event-stream' }),
        signal: attempt.signal,
      });
      for await (const message of messages) {
        if (attempt.signal.aborted) break;
        arm();
        if (message.data === undefined) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        failures = 0;
        setConnected(shared, true);
        dispatchFrame(shared, frame, cursors);
      }
    } catch {
      // A failed connect or a dropped body. The backoff below retries it.
    } finally {
      clearTimeout(watchdog);
      stop.removeEventListener('abort', end);
    }
    if (stop.aborted) break;
    // An upgrade (a subscriber changed the URL) reconnects at once, without
    // counting as a failure or a disconnect.
    if (shared.reconnectNow) {
      shared.reconnectNow = false;
      continue;
    }
    setConnected(shared, false);
    const delay = backoff[Math.min(failures, backoff.length - 1)] ?? 1_000;
    failures += 1;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delay);
      function done(): void {
        clearTimeout(timer);
        stop.removeEventListener('abort', done);
        resolve();
      }
      stop.addEventListener('abort', done);
    });
  }
}

/** Test-only: end and forget every stream. */
export function __resetSessionControlStreamsForTests(): void {
  for (const shared of streams.values()) shared.abort.abort();
  streams.clear();
}

/**
 * The session stream as an `EventStreamClient`, so `openEventStream` (its
 * coalescing, flush batching and reducer dispatch) reads runtime events from
 * the shared session connection instead of the sandbox proxy's `/global/event`.
 *
 * Each `global.event()` call joins the shared stream and yields its runtime
 * events until the caller aborts. The connection, its reconnects and its
 * liveness belong to the shared stream, so the caller's own watchdog must not
 * cut it (`heartbeatTimeoutMs`), and its gap repair is replaced by
 * `onResync`: a reconnect inside the box's ring loses nothing.
 */
export interface SessionStreamEventClient {
  global: {
    event: (options: { signal: AbortSignal }) => Promise<{ stream: AsyncIterable<unknown> }>;
  };
}

// replica-local: one adapter per session in this client, so `openEventStream`
// (which shares a connection per client OBJECT) fans one machine out to every
// mount instead of running one per mount and dispatching each event twice.
// ponytail: never evicted; bounded by the sessions one tab opens.
const eventClients = new Map<string, SessionStreamEventClient>();

export function sessionStreamEventClient(
  projectId: string,
  sessionId: string,
  hooks: { onResync?: () => void } = {},
): SessionStreamEventClient {
  // Resync callbacks are per caller; the client is shared. A caller that
  // passes one gets its own (uncached) client — the hook below uses the
  // shared client and subscribes to resyncs separately.
  const key = `${projectId}/${sessionId}`;
  if (!hooks.onResync) {
    const cached = eventClients.get(key);
    if (cached) return cached;
  }
  async function* iterate(signal: AbortSignal): AsyncGenerator<unknown> {
    const queue: unknown[] = [];
    let wake: () => void = () => {};
    const handle = openSessionStream({
      projectId,
      sessionId,
      runtime: true,
      onRuntimeEvent: (event) => {
        queue.push(event);
        wake();
      },
      onRuntimeResync: () => hooks.onResync?.(),
    });
    const onAbort = () => wake();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        yield queue.shift();
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      handle.close();
    }
  }
  const client: SessionStreamEventClient = {
    global: {
      event: async ({ signal }) => ({ stream: iterate(signal) }),
    },
  };
  if (!hooks.onResync) eventClients.set(key, client);
  return client;
}
