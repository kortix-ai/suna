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

interface SharedStream {
  subscribers: Set<SessionControlStreamOptions>;
  connected: boolean;
  lastQueue: SessionControlQueue | null;
  latest: Map<string, SessionControlFrame>;
  lastStatus: SessionRuntimeStatus | null;
  lastHealth: Record<string, unknown> | null;
  runtimeRefs: number;
  /** The connection's channels, so a runtime subscriber can upgrade it. */
  connectedWithRuntime: boolean;
  tabId: string | null;
  /** The next connect must happen now: a subscriber changed the URL. */
  reconnectNow: boolean;
  /** Ends the current attempt only (an upgrade), not the stream. */
  attempt: AbortController | null;
  abort: AbortController;
}

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
      tabId: null,
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
      if (target.subscribers.size > 0) return;
      target.abort.abort();
      if (streams.get(key) === target) streams.delete(key);
      if (target.connected) {
        target.connected = false;
        for (const listener of [...connectionListeners]) safely(listener);
      }
    },
  };
}

/** Join the session's stream for its control channel (the prompt queue). */
export const openSessionControlStream = openSessionStream;

/** Is this session's stream connected right now? */
export function sessionStreamConnected(projectId: string, sessionId: string): boolean {
  return streams.get(`${projectId}/${sessionId}`)?.connected === true;
}

// replica-local: listeners in this client, told when any stream connects or drops.
const connectionListeners = new Set<() => void>();

/** Called whenever any session stream connects or drops. Returns the unsubscribe. */
export function subscribeSessionStreamConnections(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // One subscriber must not break the stream for the others.
  }
}

function each(shared: SharedStream, fn: (subscriber: SessionControlStreamOptions) => void): void {
  for (const subscriber of [...shared.subscribers]) safely(() => fn(subscriber));
}

function setConnected(shared: SharedStream, connected: boolean): void {
  if (shared.connected === connected) return;
  shared.connected = connected;
  each(shared, (subscriber) => subscriber.onConnectionChange?.(connected));
  for (const listener of [...connectionListeners]) safely(listener);
}

async function run(options: SessionControlStreamOptions, shared: SharedStream): Promise<void> {
  const backoff = options.timing?.backoffMs ?? BACKOFF_MS;
  const livenessMs = options.timing?.livenessMs ?? LIVENESS_MS;
  const stop = shared.abort.signal;
  let cseq: number | null = null;
  let cepoch: string | null = null;
  let seq: number | null = null;
  let epoch: string | null = null;
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
    try {
      const url = new URL(
        `${platformConfig().backendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(options.projectId)}/sessions/${encodeURIComponent(options.sessionId)}/events`,
      );
      if (!withRuntime) url.searchParams.set('channels', 'control');
      if (shared.tabId) url.searchParams.set('tab_id', shared.tabId);
      if (withRuntime && seq !== null && epoch) {
        url.searchParams.set('since', String(seq));
        url.searchParams.set('epoch', epoch);
      }
      if (cseq !== null && cepoch) {
        url.searchParams.set('since_control', String(cseq));
        url.searchParams.set('cepoch', cepoch);
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
        const type = typeof frame.type === 'string' ? frame.type : '';

        if (frame.channel === 'runtime') {
          if (type === 'kortix.resync') {
            // The box could not replay the gap. Nothing after it is lost, but
            // what fell in the gap is: the view re-reads what it holds.
            seq = null;
            epoch = typeof frame.epoch === 'string' ? frame.epoch : null;
            each(shared, (subscriber) => subscriber.onRuntimeResync?.());
            continue;
          }
          if (typeof frame.epoch === 'string') epoch = frame.epoch;
          if (typeof frame.seq === 'number') seq = frame.seq;
          // Daemon bookkeeping (`kortix.hello`, `kortix.turn`, `kortix.heartbeat`,
          // `kortix.boot`) is the server's to read, not the reducer's.
          if (!type || type.startsWith('kortix.') || typeof frame.seq !== 'number') continue;
          const event = {
            // The dedupe key a redelivered delta must keep: stable across a
            // replay, distinct across a daemon restart (the epoch).
            id: `${epoch ?? ''}:${frame.seq}`,
            type,
            properties: frame.payload,
          } as unknown as RuntimeEvent;
          each(shared, (subscriber) => {
            if (subscriber.runtime) subscriber.onRuntimeEvent?.(event);
          });
          continue;
        }

        if (type === 'kortix.stream.heartbeat') {
          each(shared, (subscriber) => subscriber.onHeartbeat?.());
          continue;
        }
        if (type === 'kortix.runtime.status') {
          const status: SessionRuntimeStatus = {
            state: frame.state === 'up' ? 'up' : 'down',
            reason: typeof frame.reason === 'string' ? frame.reason : null,
          };
          shared.lastStatus = status;
          each(shared, (subscriber) => {
            if (subscriber.runtime) subscriber.onRuntimeStatus?.(status);
          });
          continue;
        }
        if (type === 'kortix.runtime.health') {
          const health = (frame.health ?? null) as Record<string, unknown> | null;
          if (!health) continue;
          shared.lastHealth = health;
          each(shared, (subscriber) => {
            if (subscriber.runtime) subscriber.onRuntimeHealth?.(health);
          });
          continue;
        }
        if (type === 'kortix.control.resync') {
          // The gap could not be replayed. The server sends every subsystem
          // again; a reconnect before that must ask for it too.
          cseq = null;
          cepoch = typeof frame.cepoch === 'string' ? frame.cepoch : null;
          continue;
        }
        if (frame.channel !== 'control' || typeof frame.cseq !== 'number') continue;
        cseq = frame.cseq;
        cepoch = typeof frame.cepoch === 'string' ? frame.cepoch : cepoch;
        const control: SessionControlFrame = {
          type,
          cseq: frame.cseq,
          cepoch: cepoch ?? '',
          at: typeof frame.at === 'number' ? frame.at : Date.now(),
          payload: frame.payload,
        };
        shared.latest.set(type, control);
        each(shared, (subscriber) => subscriber.onControl?.(control));
        const payload = frame.payload as SessionControlQueue | undefined;
        if (type === 'kortix.control.queue' && payload?.known && Array.isArray(payload.prompts)) {
          shared.lastQueue = payload;
          each(shared, (subscriber) => subscriber.onQueue?.(payload));
        }
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
