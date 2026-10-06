/**
 * The session's CONTROL channel, read for the prompt queue.
 *
 * `GET .../sessions/:sid/events?channels=control` serves the API's own
 * snapshots (`kortix.control.*`) and the stream's hello/heartbeat, and never
 * attaches to the sandbox. A database trigger makes every write of an inbox
 * row a `kortix.control.queue` frame at once, on whichever API replica serves
 * the stream. So a queue change reaches the tab in one round trip, and the
 * per-tab `GET .../prompts` poll is only the fallback for a gap in this stream.
 *
 * One connection per session per client, however many callers open it.
 * Reconnect is a capped backoff that resumes at the control cursor
 * (`since_control` + `cepoch`); a `kortix.control.resync` drops the cursor, and
 * the server then sends a full snapshot. Every frame, and the typed
 * `kortix.stream.heartbeat` every 15 s, proves liveness. Silence past
 * `livenessMs` ends the connection and reconnects.
 *
 * Framework-free: `react/use-session-prompts.ts` applies the frames to its
 * cache. Auth is the platform seam (`platformEventTransport`).
 */

import { platformConfig } from '../http/config';
import type { SessionPrompt } from '../rest/projects-client/sessions';
import { platformEventTransport } from '../stream/platform-event-transport';

/** The payload of a `kortix.control.queue` frame: the whole inbox. */
export interface SessionControlQueue {
  known: boolean;
  prompts: SessionPrompt[];
  held: boolean;
  /** The server clock when the reconciler asked for this list. */
  observed_at?: string;
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
  onQueue?: (queue: SessionControlQueue) => void;
  /** `true` on the first frame of a connection, `false` when it drops. */
  onConnectionChange?: (connected: boolean) => void;
  /** Test seam. The first opener of a session sets it. */
  timing?: SessionControlStreamTiming;
}

export interface SessionControlStreamHandle {
  connected: () => boolean;
  /** The last queue frame this stream delivered, or null before the first. */
  lastQueue: () => SessionControlQueue | null;
  close: () => void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const LIVENESS_MS = 45_000;

interface SharedStream {
  subscribers: Set<SessionControlStreamOptions>;
  connected: boolean;
  lastQueue: SessionControlQueue | null;
  abort: AbortController;
}

const streams = new Map<string, SharedStream>();

/** Join (or open) the session's control stream. `close()` leaves it. */
export function openSessionControlStream(
  options: SessionControlStreamOptions,
): SessionControlStreamHandle {
  const key = `${options.projectId}/${options.sessionId}`;
  let shared = streams.get(key);
  if (!shared) {
    shared = { subscribers: new Set(), connected: false, lastQueue: null, abort: new AbortController() };
    streams.set(key, shared);
    void run(options, shared);
  }
  const target = shared;
  target.subscribers.add(options);
  if (target.connected) options.onConnectionChange?.(true);
  let closed = false;
  return {
    connected: () => target.connected,
    lastQueue: () => target.lastQueue,
    close: () => {
      if (closed) return;
      closed = true;
      target.subscribers.delete(options);
      if (target.subscribers.size > 0) return;
      target.abort.abort();
      if (streams.get(key) === target) streams.delete(key);
    },
  };
}

function setConnected(shared: SharedStream, connected: boolean): void {
  if (shared.connected === connected) return;
  shared.connected = connected;
  for (const subscriber of [...shared.subscribers]) {
    try {
      subscriber.onConnectionChange?.(connected);
    } catch {
      // One subscriber must not break the stream for the others.
    }
  }
}

async function run(options: SessionControlStreamOptions, shared: SharedStream): Promise<void> {
  const backoff = options.timing?.backoffMs ?? BACKOFF_MS;
  const livenessMs = options.timing?.livenessMs ?? LIVENESS_MS;
  const stop = shared.abort.signal;
  let cseq: number | null = null;
  let cepoch: string | null = null;
  let failures = 0;

  while (!stop.aborted) {
    const attempt = new AbortController();
    const end = () => attempt.abort();
    stop.addEventListener('abort', end);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(end, livenessMs);
    };
    arm();
    try {
      const url = new URL(
        `${platformConfig().backendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(options.projectId)}/sessions/${encodeURIComponent(options.sessionId)}/events`,
      );
      url.searchParams.set('channels', 'control');
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
        if (frame.type === 'kortix.control.resync') {
          // The gap could not be replayed. The server sends every subsystem
          // again; a reconnect before that must ask for it too.
          cseq = null;
          cepoch = typeof frame.cepoch === 'string' ? frame.cepoch : null;
          continue;
        }
        if (frame.channel === 'control' && typeof frame.cseq === 'number') {
          cseq = frame.cseq;
          cepoch = typeof frame.cepoch === 'string' ? frame.cepoch : cepoch;
        }
        const payload = frame.payload as SessionControlQueue | undefined;
        if (frame.type === 'kortix.control.queue' && payload?.known && Array.isArray(payload.prompts)) {
          shared.lastQueue = payload;
          for (const subscriber of [...shared.subscribers]) {
            try {
              subscriber.onQueue?.(payload);
            } catch {
              // One subscriber must not break the stream for the others.
            }
          }
        }
      }
    } catch {
      // A failed connect or a dropped body. The backoff below retries it.
    } finally {
      clearTimeout(watchdog);
      stop.removeEventListener('abort', end);
    }
    if (stop.aborted) break;
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
