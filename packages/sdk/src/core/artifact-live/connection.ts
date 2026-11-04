/**
 * The live connection of one open Artifact (KRTX-3669): who else is here, where
 * their cursor is, and a ping when comments, activity or content changed.
 *
 * Framework-free. The socket is injected (`webSocket`, default the global
 * `WebSocket`), and so is the clock (`timers`, the `openEventStream` seam), so
 * the same code runs in a browser, React Native, Bun, Node ≥ 22 and a test.
 *
 * Owns: the ticket per attempt, the hello, the heartbeat, client-side pacing
 * (frames coalesce to the newest value per field; there is never a backlog),
 * reconnect with backoff, and the replay of this viewer's state after a
 * reconnect. Every server frame is validated; an invalid one is dropped.
 */

import { platformConfig } from '../http/config';
import { createArtifactLiveTicket, type ArtifactLiveTicket } from '../rest/projects-client/artifact-live';
import type { EventStreamTimerHandle, EventStreamTimers } from '../stream/event-stream';
import { stripTrailingSlashes } from '../../platform/strings';
import {
  ARTIFACT_LIVE_CLOSE,
  ARTIFACT_LIVE_LIMITS,
  encodeArtifactLiveClientFrame,
  parseArtifactLiveServerFrame,
  type ArtifactLiveChange,
  type ArtifactLiveClientFrame,
  type ArtifactLiveParticipant,
  type ArtifactLivePosition,
  type ArtifactLiveRange,
  type ArtifactLiveServerFrame,
  type ArtifactLiveTyping,
  type ArtifactLiveView,
} from './protocol';

/**
 * `connecting`: the first attempt is in progress. `live`: the server welcomed
 * this connection. `reconnecting`: an attempt failed or the socket dropped; the
 * next attempt is scheduled. `closed`: the host called `close()`. `access_lost`:
 * the caller may no longer view the Artifact (close `4403`, or a ticket refused
 * with `403`/`404`). `closed` and `access_lost` are final.
 */
export type ArtifactLiveConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'access_lost';

/**
 * What the connection reports, in order:
 * - `status`: the status changed (the initial `connecting` is not reported);
 * - `welcome`: the server accepted this connection as participant `you`.
 *   `sends: false` means the Artifact already has the maximum number of
 *   participants who send presence: this one sees presence and sends none;
 * - `presence`: the full participant list, this connection included;
 * - `changed`: refetch `what` through REST;
 * - `resync`: a connection is live again after a drop or a failed attempt.
 *   Changes may have been missed: refetch everything once.
 */
export type ArtifactLiveEvent =
  | { type: 'status'; status: ArtifactLiveConnectionStatus }
  | { type: 'welcome'; you: string; sends: boolean }
  | { type: 'presence'; participants: ArtifactLiveParticipant[] }
  | { type: 'changed'; what: ArtifactLiveChange; version: string | null }
  | { type: 'resync' };

/** The part of a WebSocket the connection uses. The browser, Bun, Node and React Native sockets fit it. */
export interface ArtifactLiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

/** A WebSocket constructor, for example the global `WebSocket`. */
export type ArtifactLiveWebSocket = new (url: string) => ArtifactLiveSocket;

export interface ArtifactLiveConnectionOptions {
  projectId: string;
  artifactId: string;
  /** How this viewer shows the Artifact. */
  view: ArtifactLiveView;
  /** The version this viewer shows (`entry_version`, at most 512 characters), sent with every hello. Default null. */
  version?: string | null;
  /** The tab is in the background: others see the avatar but no cursor. Default false. */
  hidden?: boolean;
  /** Mints a one-use ticket for each attempt. Default `createArtifactLiveTicket(projectId, artifactId)`. */
  getTicket?: () => Promise<ArtifactLiveTicket | string>;
  /** The WebSocket constructor. Default the global `WebSocket`; without one, creation throws. */
  webSocket?: ArtifactLiveWebSocket;
  /** The Kortix API base, e.g. `https://api.kortix.com/v1`. Default the configured `backendUrl`. */
  backendUrl?: string;
  /** Called once per event; a throw here is caught. */
  onEvent?: (event: ArtifactLiveEvent) => void;
  /** Test-only clock/timer override. Defaults to the real `Date.now`/`setTimeout`. */
  timers?: EventStreamTimers;
}

/**
 * One live connection. The setters return false, and send nothing, for a value
 * the protocol refuses (too long, a NUL, a fraction outside 0–1, an id that is
 * not a UUID) or after the connection ended. They never throw.
 */
export interface ArtifactLiveConnection {
  readonly status: ArtifactLiveConnectionStatus;
  /** The last presence list, this connection included. Kept while reconnecting; empty once ended. */
  readonly participants: ArtifactLiveParticipant[];
  /** This connection's participant id, from the last welcome. */
  readonly you: string | null;
  /** Where this viewer's caret or pointer is; null when it left the Artifact. */
  setCursor(at: ArtifactLivePosition | null): boolean;
  setSelection(range: ArtifactLiveRange | null): boolean;
  /** This viewer started (`active: true`) or stopped typing at `where`. */
  setTyping(where: ArtifactLiveTyping, active: boolean): boolean;
  /** The thread this viewer has open, or null. */
  setFocus(threadId: string | null): boolean;
  setHidden(hidden: boolean): boolean;
  /** Says bye, closes the socket and stops. Idempotent. */
  close(): void;
}

/** At most 8 frames a second: 2 under the server's limit, so a network stall that bunches frames does not trip 4429. */
const SEND_INTERVAL_MS = Math.ceil(1_000 / (ARTIFACT_LIVE_LIMITS.clientFramesPerSecond - 2));
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const RECONNECT_JITTER = 0.5;
/** A connection live this long resets the backoff. */
const STABLE_MS = 10_000;
/** A socket that is not welcomed within this time is replaced. */
const CONNECT_TIMEOUT_MS = 20_000;
/** At a ping, a socket that received nothing for this long missed a pong: it is dead. */
const DEAD_AFTER_MS = ARTIFACT_LIVE_LIMITS.heartbeatMs * 1.5;

const realTimers: EventStreamTimers = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  random: () => Math.random(),
};

type FieldKind = 'cursor' | 'selection' | 'typing' | 'focus' | 'hide';
type Kind = FieldKind | 'ping';

function globalWebSocket(): ArtifactLiveWebSocket | undefined {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof candidate === 'function' ? (candidate as ArtifactLiveWebSocket) : undefined;
}

/**
 * Open the live connection of one Artifact. It connects at once and reconnects
 * by itself (backoff 1, 2, 4 … 30 s, a fresh ticket each time) until `close()`
 * or until access is lost.
 */
export function createArtifactLiveConnection(options: ArtifactLiveConnectionOptions): ArtifactLiveConnection {
  const found = options.webSocket ?? globalWebSocket();
  if (!found) {
    throw new TypeError('createArtifactLiveConnection: this runtime has no WebSocket. Pass options.webSocket.');
  }
  const WebSocketImpl: ArtifactLiveWebSocket = found;
  const t = options.timers ?? realTimers;
  const getTicket = options.getTicket ?? (() => createArtifactLiveTicket(options.projectId, options.artifactId));
  const version = options.version ?? null;

  let status: ArtifactLiveConnectionStatus = 'connecting';
  let participants: ArtifactLiveParticipant[] = [];
  let you: string | null = null;

  // This viewer's state. It is replayed after every welcome.
  let hidden = options.hidden ?? false;
  let cursor: ArtifactLivePosition | null = null;
  let selection: ArtifactLiveRange | null = null;
  let typing: { where: ArtifactLiveTyping; active: boolean } | null = null;
  let focus: string | null = null;

  // The current socket, and what it has sent.
  let socket: ArtifactLiveSocket | null = null;
  let socketOpen = false;
  let liveSince: number | null = null;
  let sends = true;
  let helloHidden = hidden;
  let lastReceivedAt = 0;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  const pending = new Map<Kind, string>();
  const lastSent = new Map<Kind, string>();

  let attempts = 0;
  let failures = 0;
  let reconnectTimer: EventStreamTimerHandle | undefined;
  let connectTimer: EventStreamTimerHandle | undefined;
  let heartbeatTimer: EventStreamTimerHandle | undefined;
  let pumpTimer: EventStreamTimerHandle | undefined;

  const ended = () => status === 'closed' || status === 'access_lost';

  function emit(event: ArtifactLiveEvent) {
    try {
      options.onEvent?.(event);
    } catch {
      // One bad handler never breaks the connection.
    }
  }

  function setStatus(next: ArtifactLiveConnectionStatus) {
    if (status === next) return;
    status = next;
    emit({ type: 'status', status: next });
  }

  function liveUrl(ticket: string): string {
    const backendUrl = options.backendUrl ?? platformConfig().backendUrl;
    const origin = typeof window !== 'undefined' ? window.location?.href : undefined;
    const url = new URL(
      `${stripTrailingSlashes(backendUrl)}/projects/${encodeURIComponent(options.projectId)}/artifacts/${encodeURIComponent(options.artifactId)}/live`,
      origin,
    );
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    // A browser blocks ws:// from an https page (mixed content).
    if (url.protocol === 'ws:' && typeof window !== 'undefined' && window.location?.protocol === 'https:') url.protocol = 'wss:';
    url.searchParams.set('ticket', ticket);
    return url.toString();
  }

  function clearSocketTimers() {
    t.clearTimeout(connectTimer);
    t.clearTimeout(heartbeatTimer);
    t.clearTimeout(pumpTimer);
    connectTimer = heartbeatTimer = pumpTimer = undefined;
  }

  function stop(final: 'closed' | 'access_lost') {
    t.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearSocketTimers();
    const previous = socket;
    socket = null;
    liveSince = null;
    if (previous) {
      try {
        previous.close(1000);
      } catch {
        // Already closed.
      }
    }
    participants = [];
    setStatus(final);
  }

  function retry() {
    clearSocketTimers();
    if (liveSince !== null && t.now() - liveSince >= STABLE_MS) failures = 0;
    liveSince = null;
    failures++;
    const base = Math.min(BASE_RECONNECT_MS * 2 ** Math.min(failures - 1, 5), MAX_RECONNECT_MS);
    const delay = Math.min(Math.round(base * (1 + RECONNECT_JITTER * (t.random?.() ?? 0))), MAX_RECONNECT_MS);
    setStatus('reconnecting');
    reconnectTimer = t.setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  }

  /** The client gave up on this socket (no welcome, or a missed pong). */
  function abandon(dead: ArtifactLiveSocket) {
    if (socket !== dead) return;
    socket = null;
    try {
      dead.close(1000);
    } catch {
      // Already closed.
    }
    retry();
  }

  async function connect() {
    if (ended()) return;
    attempts++;
    let ticket: string;
    try {
      const minted = await getTicket();
      ticket = typeof minted === 'string' ? minted : minted.ticket;
    } catch (error) {
      if (ended()) return;
      const httpStatus = (error as { status?: unknown } | null)?.status;
      if (httpStatus === 403 || httpStatus === 404) return stop('access_lost');
      return retry();
    }
    if (ended()) return;
    let next: ArtifactLiveSocket;
    try {
      next = new WebSocketImpl(liveUrl(ticket));
    } catch {
      return retry();
    }
    socket = next;
    socketOpen = false;
    sends = true;
    lastSentAt = Number.NEGATIVE_INFINITY;
    pending.clear();
    lastSent.clear();
    connectTimer = t.setTimeout(() => abandon(next), CONNECT_TIMEOUT_MS);
    next.addEventListener('open', () => {
      if (socket !== next) return;
      socketOpen = true;
      helloHidden = hidden;
      const hello = encodeArtifactLiveClientFrame({ v: 1, t: 'hello', view: options.view, version, hidden });
      if (hello && send(next, hello)) {
        // The hello set `hidden`: a hide frame with the same value is not sent.
        const hide = encodeArtifactLiveClientFrame({ v: 1, t: 'hide', hidden });
        if (hide) lastSent.set('hide', hide);
      }
    });
    next.addEventListener('message', (event) => {
      if (socket !== next) return;
      lastReceivedAt = t.now();
      const data = (event as { data?: unknown } | null)?.data;
      const frame = typeof data === 'string' ? parseArtifactLiveServerFrame(data) : null;
      if (frame) receive(next, frame);
    });
    next.addEventListener('close', (event) => {
      if (socket !== next) return;
      socket = null;
      if ((event as { code?: unknown } | null)?.code === ARTIFACT_LIVE_CLOSE.accessLost) return stop('access_lost');
      retry();
    });
  }

  function receive(current: ArtifactLiveSocket, frame: ArtifactLiveServerFrame) {
    switch (frame.t) {
      case 'welcome': {
        if (liveSince !== null) {
          // A later welcome on the same socket: a place under the participant cap
          // freed (sends: true) or was taken. It is not a reconnect.
          const promoted = frame.sends && !sends;
          you = frame.you;
          sends = frame.sends;
          if (!sends) for (const kind of [...pending.keys()]) if (kind !== 'ping') pending.delete(kind);
          emit({ type: 'welcome', you: frame.you, sends: frame.sends });
          if (promoted) replay();
          return;
        }
        t.clearTimeout(connectTimer);
        connectTimer = undefined;
        liveSince = t.now();
        you = frame.you;
        sends = frame.sends;
        emit({ type: 'welcome', you: frame.you, sends: frame.sends });
        setStatus('live');
        if (attempts > 1) emit({ type: 'resync' });
        heartbeat(current);
        replay();
        return;
      }
      case 'presence':
        participants = frame.participants;
        emit({ type: 'presence', participants });
        return;
      case 'changed':
        emit({ type: 'changed', what: frame.what, version: frame.version });
        return;
      case 'pong':
        return;
    }
  }

  function heartbeat(current: ArtifactLiveSocket) {
    heartbeatTimer = t.setTimeout(() => {
      heartbeatTimer = undefined;
      if (socket !== current) return;
      if (t.now() - lastReceivedAt > DEAD_AFTER_MS) return abandon(current);
      const ping = encodeArtifactLiveClientFrame({ v: 1, t: 'ping' });
      if (ping) queue('ping', ping);
      heartbeat(current);
    }, ARTIFACT_LIVE_LIMITS.heartbeatMs);
  }

  function send(target: ArtifactLiveSocket, raw: string): boolean {
    try {
      target.send(raw);
      lastSentAt = t.now();
      return true;
    } catch {
      return false;
    }
  }

  /** Keep only the newest frame per kind; a frame equal to the one last sent is not sent again. */
  function queue(kind: Kind, raw: string) {
    if (kind !== 'ping' && lastSent.get(kind) === raw) pending.delete(kind);
    else pending.set(kind, raw);
    pump();
  }

  /** Send the oldest pending kind once the pacing allows, then schedule the next. */
  function pump() {
    if (pumpTimer !== undefined) return;
    const current = socket;
    if (!current || liveSince === null || pending.size === 0) return;
    const wait = lastSentAt + SEND_INTERVAL_MS - t.now();
    if (wait > 0) {
      pumpTimer = t.setTimeout(() => {
        pumpTimer = undefined;
        pump();
      }, wait);
      return;
    }
    const [kind, raw] = pending.entries().next().value as [Kind, string];
    pending.delete(kind);
    if (send(current, raw)) lastSent.set(kind, raw);
    pump();
  }

  function frameOf(kind: FieldKind): ArtifactLiveClientFrame {
    switch (kind) {
      case 'cursor':
        return { v: 1, t: 'cursor', at: cursor };
      case 'selection':
        return { v: 1, t: 'selection', range: selection };
      case 'typing':
        return { v: 1, t: 'typing', where: typing?.where ?? 'doc', active: typing?.active ?? false };
      case 'focus':
        return { v: 1, t: 'focus', thread_id: focus };
      case 'hide':
        return { v: 1, t: 'hide', hidden };
    }
  }

  function offer(kind: FieldKind) {
    if (!socket || liveSince === null || !sends) return;
    const raw = encodeArtifactLiveClientFrame(frameOf(kind));
    if (raw) queue(kind, raw);
  }

  /** A new participant starts empty: send what this viewer has set. */
  function replay() {
    if (!sends) return;
    if (cursor) offer('cursor');
    if (selection) offer('selection');
    if (typing?.active) offer('typing');
    if (focus) offer('focus');
    if (hidden !== helloHidden) offer('hide');
  }

  /**
   * The server drops a hidden participant's cursor, selection, typing and
   * focus. After un-hiding, send them again as fresh frames, queued after the
   * hide frame.
   */
  function resendShown() {
    for (const kind of ['cursor', 'selection', 'typing', 'focus'] as const) {
      lastSent.delete(kind);
      pending.delete(kind);
    }
    if (cursor) offer('cursor');
    if (selection) offer('selection');
    if (typing?.active) offer('typing');
    if (focus) offer('focus');
  }

  /** Validate, store, and offer one field. */
  function set(frame: ArtifactLiveClientFrame, kind: FieldKind, store: () => void): boolean {
    if (ended() || encodeArtifactLiveClientFrame(frame) === null) return false;
    store();
    offer(kind);
    return true;
  }

  void connect();

  return {
    get status() {
      return status;
    },
    get participants() {
      return participants;
    },
    get you() {
      return you;
    },
    setCursor: (at) => set({ v: 1, t: 'cursor', at }, 'cursor', () => { cursor = at; }),
    setSelection: (range) => set({ v: 1, t: 'selection', range }, 'selection', () => { selection = range; }),
    setTyping: (where, active) => set({ v: 1, t: 'typing', where, active }, 'typing', () => { typing = { where, active }; }),
    setFocus: (threadId) => set({ v: 1, t: 'focus', thread_id: threadId }, 'focus', () => { focus = threadId; }),
    setHidden: (next) => {
      const unhiding = hidden && !next;
      if (!set({ v: 1, t: 'hide', hidden: next }, 'hide', () => { hidden = next; })) return false;
      if (unhiding) resendShown();
      return true;
    },
    close() {
      if (ended()) return;
      const current = socket;
      if (current && socketOpen) {
        const bye = encodeArtifactLiveClientFrame({ v: 1, t: 'bye' });
        if (bye) send(current, bye);
      }
      stop('closed');
    },
  };
}
