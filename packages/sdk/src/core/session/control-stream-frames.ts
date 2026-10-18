/**
 * The per-frame protocol dispatch of the session control stream, and the
 * subscriber fan-out it drives — the isomorphic half of `control-stream.ts`
 * (the transport lifecycle there: connect, watchdog, backoff, upgrade).
 *
 * `dispatchFrame` reduces one parsed SSE frame against the shared stream
 * state: the runtime channel (sequenced events, resync), the typed
 * heartbeats, the runtime status/health pushes, and the `kortix.control.*`
 * snapshots. It is the same linear chain, in the same order, the reducer in
 * `run()` executed inline — the four stream cursors are the one explicit
 * `FrameCursors` object the caller owns.
 *
 * Framework-free: no transport, no timers, no module state but the
 * connection listeners.
 */
import type { RuntimeEvent } from '../stream/event-stream';
import type {
  SessionControlFrame,
  SessionControlQueue,
  SessionControlStreamOptions,
  SessionRuntimeStatus,
} from './control-stream';

/** The stream cursors (`since`+`epoch` for the runtime log, `since_control`+
 *  `cepoch` for the control channel), carried across reconnects by the owner. */
export interface FrameCursors {
  seq: number | null;
  epoch: string | null;
  cseq: number | null;
  cepoch: string | null;
}

/** The shared connection state every subscriber of one session reads. */
export interface SharedStream {
  subscribers: Set<SessionControlStreamOptions>;
  connected: boolean;
  lastQueue: SessionControlQueue | null;
  latest: Map<string, SessionControlFrame>;
  lastStatus: SessionRuntimeStatus | null;
  lastHealth: Record<string, unknown> | null;
  runtimeRefs: number;
  /** The connection's channels, so a runtime subscriber can upgrade it. */
  connectedWithRuntime: boolean;
  /** Subscribers asking for `schema=v2`, and whether the connection carries it. */
  logRefs: number;
  connectedWithLog: boolean;
  tabId: string | null;
  /**
   * The server owns session state (R5): it sent `kortix.control.session`. An
   * API from before R5 never does, and against it the SDK keeps every poll.
   */
  authoritative: boolean;
  /** The next connect must happen now: a subscriber changed the URL. */
  reconnectNow: boolean;
  /** Ends the current attempt only (an upgrade), not the stream. */
  attempt: AbortController | null;
  abort: AbortController;
}

export function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // One subscriber must not break the stream for the others.
  }
}

export function each(
  shared: SharedStream,
  fn: (subscriber: SessionControlStreamOptions) => void,
): void {
  for (const subscriber of [...shared.subscribers]) safely(() => fn(subscriber));
}

/** The runtime-callback fan-out: a subscriber without `runtime: true` never sees runtime frames. */
function eachRuntime<T>(
  shared: SharedStream,
  fn: (subscriber: SessionControlStreamOptions, value: T) => void,
  value: T,
): void {
  each(shared, (subscriber) => {
    if (subscriber.runtime) fn(subscriber, value);
  });
}

/** Called whenever any session stream connects or drops. Returns the unsubscribe. */
export function subscribeSessionStreamConnections(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

const connectionListeners = new Set<() => void>();

export function notifyConnectionListeners(): void {
  for (const listener of [...connectionListeners]) safely(listener);
}

export function dispatchFrame(
  shared: SharedStream,
  frame: Record<string, unknown>,
  cursors: FrameCursors,
): void {
  const type = typeof frame.type === 'string' ? frame.type : '';

  if (frame.channel === 'runtime') {
    if (type === 'kortix.resync') {
      // The box could not replay the gap. Nothing after it is lost, but
      // what fell in the gap is: the view re-reads what it holds.
      cursors.seq = null;
      cursors.epoch = typeof frame.epoch === 'string' ? frame.epoch : null;
      each(shared, (subscriber) => subscriber.onRuntimeResync?.());
      return;
    }
    if (typeof frame.epoch === 'string') cursors.epoch = frame.epoch;
    if (typeof frame.seq === 'number') cursors.seq = frame.seq;
    // Daemon bookkeeping (`kortix.hello`, `kortix.turn`, `kortix.heartbeat`,
    // `kortix.boot`) is the server's to read, not the reducer's.
    if (!type || type.startsWith('kortix.') || typeof frame.seq !== 'number') return;
    const event = {
      // The dedupe key a redelivered delta must keep: stable across a
      // replay, distinct across a daemon restart (the epoch).
      id: `${cursors.epoch ?? ''}:${frame.seq}`,
      type,
      properties: frame.payload,
    } as unknown as RuntimeEvent;
    eachRuntime(
      shared,
      (subscriber, event: RuntimeEvent) => {
        subscriber.onRuntimeEvent?.(event);
      },
      event,
    );
    return;
  }

  if (type === 'kortix.stream.heartbeat') {
    each(shared, (subscriber) => subscriber.onHeartbeat?.());
    return;
  }
  if (type === 'kortix.runtime.status') {
    const status: SessionRuntimeStatus = {
      state: frame.state === 'up' ? 'up' : 'down',
      reason: typeof frame.reason === 'string' ? frame.reason : null,
    };
    shared.lastStatus = status;
    eachRuntime(
      shared,
      (subscriber, status: SessionRuntimeStatus) => {
        subscriber.onRuntimeStatus?.(status);
      },
      status,
    );
    return;
  }
  if (type === 'kortix.runtime.health') {
    const health = (frame.health ?? null) as Record<string, unknown> | null;
    if (!health) return;
    shared.lastHealth = health;
    eachRuntime(
      shared,
      (subscriber, health: Record<string, unknown>) => {
        subscriber.onRuntimeHealth?.(health);
      },
      health,
    );
    return;
  }
  if (type === 'kortix.control.resync') {
    // The gap could not be replayed. The server sends every subsystem
    // again; a reconnect before that must ask for it too.
    cursors.cseq = null;
    cursors.cepoch = typeof frame.cepoch === 'string' ? frame.cepoch : null;
    return;
  }
  if (frame.channel !== 'control' || typeof frame.cseq !== 'number') return;
  cursors.cseq = frame.cseq;
  cursors.cepoch = typeof frame.cepoch === 'string' ? frame.cepoch : cursors.cepoch;
  const control: SessionControlFrame = {
    type,
    cseq: frame.cseq,
    cepoch: cursors.cepoch ?? '',
    at: typeof frame.at === 'number' ? frame.at : Date.now(),
    payload: frame.payload,
  };
  shared.latest.set(type, control);
  if (type === 'kortix.control.session' && !shared.authoritative) {
    shared.authoritative = true;
    notifyConnectionListeners();
  }
  each(shared, (subscriber) => subscriber.onControl?.(control));
  const payload = frame.payload as SessionControlQueue | undefined;
  if (type === 'kortix.control.queue' && payload?.known && Array.isArray(payload.prompts)) {
    shared.lastQueue = payload;
    each(shared, (subscriber) => subscriber.onQueue?.(payload));
  }
}
