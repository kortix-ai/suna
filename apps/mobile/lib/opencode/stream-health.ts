/**
 * Live-update health of the OpenCode SSE stream (`event-stream.ts`), for the
 * thread's "Live updates paused · Reconnect" pill and the header's
 * "Last update 6 min ago" line (COR-144).
 *
 * The reducer, the view and the label are pure (`bun test`). The store below
 * is the one place the stream hook writes its transitions to. The hook
 * reports transitions only, never per frame: `lastEventAt` is written when the
 * connection is lost, so a streaming reply does not re-render its readers.
 */

import { create } from 'zustand';
import { HEARTBEAT_TIMEOUT_MS } from './stream-policy';

export type StreamPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'paused';

/** Why the stream stopped retrying on its own schedule. */
export type StreamPauseReason =
  /** `MAX_HARD_FAILURES` in a row: the stream parked (probes once a minute). */
  | 'gave-up'
  /** 401/403: reconnects halt until the token refreshes. */
  | 'auth';

export interface StreamHealth {
  phase: StreamPhase;
  pauseReason: StreamPauseReason | null;
  /** Last frame received (any frame, keepalives included), epoch ms. `null`
   *  before the first frame. Written on the transitions away from connected. */
  lastEventAt: number | null;
  /** When the stream stopped being connected, epoch ms. `null` while connected. */
  downSince: number | null;
}

export type StreamHealthEvent =
  /** A connect attempt starts. */
  | { type: 'connecting'; at: number }
  /** The server answered the connect. */
  | { type: 'open'; at: number }
  /** The connection was lost; a retry is scheduled. */
  | { type: 'lost'; at: number; lastEventAt: number | null }
  /** Too many failures in a row: the stream parked. */
  | { type: 'parked'; at: number; lastEventAt: number | null }
  /** 401/403: reconnects halt. */
  | { type: 'auth-failed'; at: number; lastEventAt: number | null }
  /** The stream hook unmounted (no sandbox, or a different one). */
  | { type: 'stopped' };

export const INITIAL_STREAM_HEALTH: StreamHealth = {
  phase: 'idle',
  pauseReason: null,
  lastEventAt: null,
  downSince: null,
};

/**
 * A stream that has not reconnected this long after it went down reads as
 * paused even while it still retries. Twice the watchdog: the watchdog alone
 * already allows `HEARTBEAT_TIMEOUT_MS` of silence before it forces a
 * reconnect, so this is the next full window without a working connection.
 */
export const STREAM_STALLED_MS = 2 * HEARTBEAT_TIMEOUT_MS;

export function reduceStreamHealth(state: StreamHealth, event: StreamHealthEvent): StreamHealth {
  switch (event.type) {
    case 'connecting':
      // Only the first connect changes the phase. A recycle or a foreground
      // reconnect of a connected stream is not an outage, and a parked probe
      // stays paused until it opens.
      if (state.phase !== 'idle') return state;
      return { ...state, phase: 'connecting', downSince: event.at };
    case 'open':
      return { phase: 'connected', pauseReason: null, lastEventAt: event.at, downSince: null };
    case 'lost': {
      // A failed parked probe, or a failure after a 401, stays paused.
      if (state.phase === 'paused') return state;
      const lastEventAt = event.lastEventAt ?? state.lastEventAt;
      // Every backoff retry reports again: unchanged, keep the object.
      if (state.phase === 'reconnecting' && state.lastEventAt === lastEventAt) return state;
      return {
        ...state,
        phase: 'reconnecting',
        lastEventAt,
        downSince: state.downSince ?? event.at,
      };
    }
    case 'parked':
    case 'auth-failed': {
      const pauseReason: StreamPauseReason = event.type === 'parked' ? 'gave-up' : 'auth';
      const lastEventAt = event.lastEventAt ?? state.lastEventAt;
      // A parked probe that fails reports again: unchanged, keep the object.
      if (state.phase === 'paused' && state.pauseReason === pauseReason && state.lastEventAt === lastEventAt) {
        return state;
      }
      return { phase: 'paused', pauseReason, lastEventAt, downSince: state.downSince ?? event.at };
    }
    case 'stopped':
      return INITIAL_STREAM_HEALTH;
  }
}

export type LiveUpdatesReason = StreamPauseReason | 'stalled';

export interface LiveUpdatesView {
  /** Live updates are not arriving: show the pill and the "Last update" line. */
  paused: boolean;
  reason: LiveUpdatesReason | null;
  lastEventAt: number | null;
}

/** What the thread shows for `state` at `now`. */
export function liveUpdatesView(state: StreamHealth, now: number): LiveUpdatesView {
  if (state.phase === 'paused') {
    return { paused: true, reason: state.pauseReason, lastEventAt: state.lastEventAt };
  }
  const down = state.phase === 'reconnecting' || state.phase === 'connecting';
  if (down && state.downSince !== null && now - state.downSince >= STREAM_STALLED_MS) {
    return { paused: true, reason: 'stalled', lastEventAt: state.lastEventAt };
  }
  return { paused: false, reason: null, lastEventAt: state.lastEventAt };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The header's status line while paused: "Last update just now",
 * "Last update 6 min ago", "Last update 2 hr ago", "Last update 3 days ago".
 * With no frame ever received: "Live updates paused".
 */
export function lastUpdateLabel(lastEventAt: number | null, now: number): string {
  if (lastEventAt === null || !Number.isFinite(lastEventAt)) return 'Live updates paused';
  const ms = Math.max(0, now - lastEventAt);
  if (ms < MINUTE_MS) return 'Last update just now';
  if (ms < HOUR_MS) return `Last update ${Math.floor(ms / MINUTE_MS)} min ago`;
  if (ms < DAY_MS) return `Last update ${Math.floor(ms / HOUR_MS)} hr ago`;
  const days = Math.floor(ms / DAY_MS);
  return `Last update ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface StreamHealthStore {
  health: StreamHealth;
  dispatch: (event: StreamHealthEvent) => void;
  /** Restart the stream now. A no-op while no stream is mounted. */
  reconnect: () => void;
  /** Set by the mounted stream hook; returns the unregister function. */
  registerReconnect: (handler: () => void) => () => void;
}

let reconnectHandler: (() => void) | null = null;

export const useStreamHealthStore = create<StreamHealthStore>((set) => ({
  health: INITIAL_STREAM_HEALTH,
  dispatch: (event) =>
    set((store) => {
      const health = reduceStreamHealth(store.health, event);
      return health === store.health ? store : { health };
    }),
  reconnect: () => reconnectHandler?.(),
  registerReconnect: (handler) => {
    reconnectHandler = handler;
    return () => {
      if (reconnectHandler === handler) reconnectHandler = null;
    };
  },
}));
