/**
 * The live rooms of Artifacts in one API process (KRTX-3669): who is on each
 * Artifact, their cursors, selections and typing, and the agents at work.
 *
 * Pure state over an injected clock. Two outputs: the sockets this process
 * holds, and `relay`, the deltas `live-hub.ts` sends to the other processes on
 * `kortix_artifact_live`. No database and no timer of its own.
 *
 * The budget (`ARTIFACT_LIVE_LIMITS`):
 *   - a client frame over 1 KB or not valid closes the socket (4400);
 *   - a client sends at most 10 frames per second; the rest are dropped, and
 *     50 dropped frames within 5 s close the socket (4429);
 *   - presence to a room's sockets is coalesced to one frame per 100 ms;
 *   - a participant's delta reaches other processes at most 5 times per
 *     second, the newest state last;
 *   - at most 50 participants are listed; a socket beyond that sees presence
 *     and sends none (`welcome.sends=false`) until a place frees;
 *   - a socket silent for 45 s is closed; another process's participant that
 *     is not refreshed for 45 s is dropped; an agent with no signal for 2 min
 *     leaves;
 *   - a hidden participant shows its avatar and never a cursor, a selection or
 *     typing, here or on another process.
 */
import { randomBytes } from 'node:crypto';
import {
  ARTIFACT_LIVE_CLOSE,
  ARTIFACT_LIVE_LIMITS,
  ARTIFACT_LIVE_VERSION,
  artifactLiveColor,
  parseArtifactLiveClientFrame,
  type ArtifactLiveAgentSignal,
  type ArtifactLiveChange,
  type ArtifactLiveClientFrame,
  type ArtifactLiveParticipant,
  type ArtifactLivePosition,
  type ArtifactLiveServerFrame,
  type ArtifactLiveStatus,
  type ArtifactLiveTyping,
} from '@kortix/shared/artifact-live';

const L = ARTIFACT_LIVE_LIMITS;
const V = ARTIFACT_LIVE_VERSION;

/** One presence frame per room per this many ms. */
export const PRESENCE_COALESCE_MS = 100;
/** Two relays of one participant are at least this far apart: `relayFramesPerSecond`. */
export const RELAY_SPACING_MS = Math.ceil(1000 / L.relayFramesPerSecond);
/** A local participant is re-sent this often, so other processes do not expire it. */
export const KEEPALIVE_MS = 20_000;
/** A `sync` request is answered at most this often per room. */
export const SYNC_REPLY_SPACING_MS = 1_000;
/** Dropped frames within ABUSE_WINDOW_MS that close the socket with 4429: twice the rate, sustained. */
export const ABUSE_WINDOW_MS = 5_000;
export const ABUSE_DROPS = 5 * L.clientFramesPerSecond;
/** The schema's bound on one presence frame. */
export const PRESENCE_MAX = 200;
/** A socket closed for silence gets this code: a normal close, so the client reconnects. */
export const EXPIRED_CLOSE = 1000;

export interface LiveSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

export interface LiveClock {
  now(): number;
  /** Run `fn` after `ms`; returns the cancel function. */
  later(fn: () => void, ms: number): () => void;
}

export type LiveWho = ArtifactLiveParticipant['who'];

/** Who a socket is, resolved once at the upgrade. */
export interface LiveIdentity {
  who: LiveWho;
  name: string;
  avatar_url: string | null;
}

/** A delta to the other processes. `at` orders agent signals across processes. */
export type LiveRelay =
  | { k: 'up'; a: string; p: ArtifactLiveParticipant; at?: number }
  | { k: 'rm'; a: string; id: string; at?: number }
  | { k: 'sync'; a: string }
  | { k: 'aw'; a: string; s: string };

interface Relayed {
  lastAt: number;
  cancel: (() => void) | null;
}

interface Conn<M> {
  id: string;
  socket: LiveSocket;
  meta: M;
  identity: LiveIdentity;
  joinedAt: number;
  lastFrameAt: number;
  /** Its state, kept while it waits too: a promoted socket lists with its hello. */
  participant: ArtifactLiveParticipant;
  /** False while over the participant cap: it sees presence and sends none. */
  sends: boolean;
  tokens: number;
  refilledAt: number;
  dropWindowAt: number;
  drops: number;
  relay: Relayed;
}

interface Agent {
  participant: ArtifactLiveParticipant;
  joinedAt: number;
  signalAt: number;
  /** A turn of this session ran after the agent appeared: its end makes the agent leave. */
  sawLiveTurn: boolean;
  relay: Relayed;
}

interface Remote {
  participant: ArtifactLiveParticipant;
  joinedAt: number;
  seenAt: number;
  origin: string;
  at: number | null;
}

interface Room<M> {
  artifactId: string;
  projectId: string;
  conns: Map<string, Conn<M>>;
  agents: Map<string, Agent>;
  remote: Map<string, Remote>;
  flushCancel: (() => void) | null;
  lastFlushAt: number;
  contentVersion: string | null;
  syncRepliedAt: number;
}

/** The participant id of an agent session: one per session per Artifact. */
export function artifactLiveAgentId(sessionId: string): string {
  return `session:${sessionId}`;
}

/** At most `max` UTF-16 units, never half a surrogate pair. */
export function clipText(text: string, max: number): string {
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** An agent's place near a quote: the start of its first 64 units. */
export function artifactLiveQuoteCursor(quote: string): ArtifactLivePosition | null {
  const cut = clipText(quote, 64);
  return cut ? { kind: 'doc', quote: cut, prefix: '', offset: 0 } : null;
}

/** A copy with what a hidden participant never shows removed. */
function visible(participant: ArtifactLiveParticipant): ArtifactLiveParticipant {
  return participant.hidden
    ? { ...participant, cursor: null, selection: null, typing: null }
    : { ...participant };
}

function whoId(who: LiveWho): string {
  return who.kind === 'user' ? who.user_id : who.session_id;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function send(socket: LiveSocket, data: string): void {
  try {
    socket.send(data);
  } catch {
    // The socket closed between lookup and send; its close handler removes it.
  }
}

export class ArtifactLiveRooms<M = unknown> {
  private readonly rooms = new Map<string, Room<M>>();
  private readonly clock: LiveClock;
  private readonly relay: (message: LiveRelay) => void;
  private readonly newId: () => string;
  /** This process on the channel: its own echo is dropped. */
  readonly origin: string;

  constructor(options: { clock: LiveClock; relay: (message: LiveRelay) => void; origin: string; newId?: () => string }) {
    this.clock = options.clock;
    this.relay = options.relay;
    this.origin = options.origin;
    this.newId = options.newId ?? (() => `c_${randomBytes(12).toString('base64url')}`);
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Every socket this process holds. */
  *connections(): Generator<{ artifactId: string; projectId: string; id: string; meta: M }> {
    for (const room of this.rooms.values()) {
      for (const conn of room.conns.values()) yield { artifactId: room.artifactId, projectId: room.projectId, id: conn.id, meta: conn.meta };
    }
  }

  /** A new socket: `welcome`, then the presence list, then the room hears of it. */
  join(input: { artifactId: string; projectId: string; socket: LiveSocket; identity: LiveIdentity; meta: M }): { id: string; sends: boolean } {
    const now = this.clock.now();
    const room = this.ensure(input.artifactId, input.projectId);
    const firstViewer = room.conns.size === 0;
    const id = this.newId();
    const sends = this.listed(room) < L.participants;
    const conn: Conn<M> = {
      id, socket: input.socket, meta: input.meta, identity: input.identity, joinedAt: now, lastFrameAt: now,
      participant: this.person(id, input.identity), sends,
      tokens: L.clientFramesPerSecond, refilledAt: now, dropWindowAt: now, drops: 0,
      relay: { lastAt: -Infinity, cancel: null },
    };
    room.conns.set(id, conn);
    // Another process may hold viewers of this Artifact already: ask for them.
    if (firstViewer) this.relay({ k: 'sync', a: room.artifactId });
    this.sendFrame(conn.socket, { v: V, t: 'welcome', you: id, sends });
    this.sendFrame(conn.socket, this.presence(room));
    if (sends) {
      this.queueRelay(room, conn);
      this.dirty(room);
    }
    return { id, sends };
  }

  /** One raw client frame. Over the rate it is dropped; invalid, the socket closes with 4400. */
  receive(artifactId: string, connId: string, raw: string | ArrayBuffer | Uint8Array): void {
    const room = this.rooms.get(artifactId);
    const conn = room?.conns.get(connId);
    if (!room || !conn) return;
    const now = this.clock.now();
    if (!this.admit(conn, now)) {
      if (conn.drops >= ABUSE_DROPS) this.close(artifactId, connId, ARTIFACT_LIVE_CLOSE.rateLimited, 'too many frames');
      return;
    }
    const frame = parseArtifactLiveClientFrame(raw);
    if (!frame) return this.close(artifactId, connId, ARTIFACT_LIVE_CLOSE.protocol, 'invalid frame');
    conn.lastFrameAt = now;
    this.apply(room, conn, frame);
  }

  /** The socket closed: it leaves the room, and a waiting socket may take its place. */
  leave(artifactId: string, connId: string): void {
    const room = this.rooms.get(artifactId);
    const conn = room?.conns.get(connId);
    if (!room || !conn) return;
    room.conns.delete(connId);
    conn.relay.cancel?.();
    if (conn.sends) {
      this.relay({ k: 'rm', a: artifactId, id: connId });
      this.promote(room);
      this.dirty(room);
    }
    if (!room.conns.size) room.remote.clear();
    this.dropIfEmpty(room);
  }

  /** Remove the socket and close it with `code`. */
  close(artifactId: string, connId: string, code: number, reason: string): void {
    const conn = this.rooms.get(artifactId)?.conns.get(connId);
    if (!conn) return;
    this.leave(artifactId, connId);
    try {
      conn.socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** A `changed` ping to every socket on the Artifact here. */
  changed(artifactId: string, what: ArtifactLiveChange, version: string | null): void {
    const room = this.rooms.get(artifactId);
    if (!room) return;
    if (what === 'content' && version) room.contentVersion = version;
    const data = JSON.stringify({ v: V, t: 'changed', what, version } satisfies ArtifactLiveServerFrame);
    for (const conn of room.conns.values()) send(conn.socket, data);
  }

  /** An agent names its place (`POST …/live/agent`). It is inside a turn, so the turn's end makes it leave. */
  agentSignal(input: { artifactId: string; projectId: string; sessionId: string; agentName: string; signal: ArtifactLiveAgentSignal }): void {
    const { signal } = input;
    if (signal.status === 'idle') return this.agentLeave(input.artifactId, artifactLiveAgentId(input.sessionId), this.clock.now(), true);
    const typing: ArtifactLiveTyping | null = signal.status === 'writing' ? (signal.thread_id ? { thread_id: signal.thread_id } : 'doc') : null;
    this.upsertAgent({
      ...input, status: signal.status, focus: signal.thread_id ?? null,
      cursor: signal.quote ? artifactLiveQuoteCursor(signal.quote) : null, typing, sawLiveTurn: true,
    });
  }

  /** A comment hand-off reached the session: the agent appears reading at the first thread. */
  agentDelivered(input: { artifactId: string; projectId: string; sessionId: string; agentName: string; threadId: string; cursor: ArtifactLivePosition | null }): void {
    const held = this.rooms.get(input.artifactId)?.agents.get(artifactLiveAgentId(input.sessionId));
    this.upsertAgent({ ...input, status: 'reading', focus: input.threadId, typing: null, sawLiveTurn: held?.sawLiveTurn ?? false });
  }

  /** The session wrote a comment here: its "writing" ends. Another process may hold the agent: tell it. */
  agentWrote(artifactId: string, sessionId: string, relayIfElsewhere = true): void {
    const room = this.rooms.get(artifactId);
    const agent = room?.agents.get(artifactLiveAgentId(sessionId));
    if (!room || !agent) {
      if (relayIfElsewhere) this.relay({ k: 'aw', a: artifactId, s: sessionId });
      return;
    }
    if (agent.participant.status !== 'writing') return;
    agent.participant = { ...agent.participant, status: 'editing', typing: null };
    this.queueRelay(room, agent);
    this.dirty(room);
  }

  /** True when this process holds the agent of `sessionId` on some Artifact. */
  holdsAgent(sessionId: string): boolean {
    const id = artifactLiveAgentId(sessionId);
    for (const room of this.rooms.values()) if (room.agents.has(id)) return true;
    return false;
  }

  /** The session's box changed: a live turn marks it; the end of a turn it was in makes the agent leave. */
  sessionTurn(sessionId: string, live: boolean): void {
    const id = artifactLiveAgentId(sessionId);
    for (const room of [...this.rooms.values()]) {
      const agent = room.agents.get(id);
      if (!agent) continue;
      if (live) agent.sawLiveTurn = true;
      else if (agent.sawLiveTurn) this.agentLeave(room.artifactId, id, this.clock.now(), true);
    }
  }

  /** A delta from another process. Its own echo is ignored. */
  remote(origin: string, message: LiveRelay): void {
    if (origin === this.origin) return;
    const room = this.rooms.get(message.a);
    if (!room) return;
    switch (message.k) {
      case 'up':
        return this.remoteUp(room, origin, message);
      case 'rm':
        return this.remoteRm(room, origin, message);
      case 'sync':
        return this.syncReply(room);
      case 'aw':
        return this.agentWrote(message.a, message.s, false);
    }
  }

  /** Expiry and keepalive. The hub calls it every few seconds. */
  sweep(): void {
    const now = this.clock.now();
    for (const room of [...this.rooms.values()]) {
      for (const conn of [...room.conns.values()]) {
        if (now - conn.lastFrameAt > L.expireMs) this.close(room.artifactId, conn.id, EXPIRED_CLOSE, 'expired');
      }
      for (const [id, remote] of [...room.remote]) {
        if (now - remote.seenAt <= L.expireMs) continue;
        room.remote.delete(id);
        this.promote(room);
        this.dirty(room);
      }
      for (const [id, agent] of [...room.agents]) {
        if (now - agent.signalAt > L.agentIdleMs) this.agentLeave(room.artifactId, id, now, true);
      }
      if (this.rooms.get(room.artifactId) !== room) continue;
      for (const conn of room.conns.values()) {
        if (conn.sends && !conn.relay.cancel && now - conn.relay.lastAt >= KEEPALIVE_MS) this.relayNow(room, conn);
      }
      for (const agent of room.agents.values()) {
        if (!agent.relay.cancel && now - agent.relay.lastAt >= KEEPALIVE_MS) this.relayNow(room, agent);
      }
      this.dropIfEmpty(room);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private ensure(artifactId: string, projectId: string): Room<M> {
    let room = this.rooms.get(artifactId);
    if (!room) {
      room = {
        artifactId, projectId, conns: new Map(), agents: new Map(), remote: new Map(),
        flushCancel: null, lastFlushAt: -Infinity, contentVersion: null, syncRepliedAt: -Infinity,
      };
      this.rooms.set(artifactId, room);
    }
    return room;
  }

  private dropIfEmpty(room: Room<M>): void {
    if (room.conns.size || room.agents.size || this.rooms.get(room.artifactId) !== room) return;
    room.flushCancel?.();
    this.rooms.delete(room.artifactId);
  }

  private person(id: string, identity: LiveIdentity): ArtifactLiveParticipant {
    return {
      id, who: identity.who, name: identity.name, avatar_url: identity.avatar_url, color: artifactLiveColor(whoId(identity.who)),
      status: 'viewing', view: null, hidden: false, cursor: null, selection: null, typing: null, focus: null,
    };
  }

  /** Listed participants: sending sockets, agents, and other processes' participants. */
  private listed(room: Room<M>): number {
    let count = room.agents.size + room.remote.size;
    for (const conn of room.conns.values()) if (conn.sends) count++;
    return count;
  }

  /** Token bucket: `clientFramesPerSecond` per second, bursts of as many. */
  private admit(conn: Conn<M>, now: number): boolean {
    const rate = L.clientFramesPerSecond;
    conn.tokens = Math.min(rate, conn.tokens + ((now - conn.refilledAt) * rate) / 1000);
    conn.refilledAt = now;
    if (conn.tokens >= 1) {
      conn.tokens -= 1;
      return true;
    }
    if (now - conn.dropWindowAt > ABUSE_WINDOW_MS) {
      conn.dropWindowAt = now;
      conn.drops = 0;
    }
    conn.drops += 1;
    return false;
  }

  private apply(room: Room<M>, conn: Conn<M>, frame: ArtifactLiveClientFrame): void {
    if (frame.t === 'ping') return this.sendFrame(conn.socket, { v: V, t: 'pong' });
    if (frame.t === 'bye') return this.close(room.artifactId, conn.id, 1000, 'bye');
    if (frame.t === 'hello' && room.contentVersion && frame.version && frame.version !== room.contentVersion) {
      this.sendFrame(conn.socket, { v: V, t: 'changed', what: 'content', version: room.contentVersion });
    }
    const current = conn.participant;
    const next = { ...current };
    switch (frame.t) {
      case 'hello':
        next.view = frame.view;
        if (frame.hidden !== undefined) next.hidden = frame.hidden;
        break;
      case 'hide':
        next.hidden = frame.hidden;
        break;
      case 'focus':
        next.focus = frame.thread_id;
        break;
      case 'cursor':
        if (!next.hidden) next.cursor = frame.at;
        break;
      case 'selection':
        if (!next.hidden) next.selection = frame.range;
        break;
      case 'typing':
        if (!next.hidden) next.typing = frame.active ? frame.where : null;
        break;
    }
    const shown = visible(next);
    if (same(shown, current)) return;
    conn.participant = shown;
    // A waiting socket keeps its state for later and shows nothing now.
    if (!conn.sends) return;
    this.queueRelay(room, conn);
    this.dirty(room);
  }

  private upsertAgent(input: {
    artifactId: string; projectId: string; sessionId: string; agentName: string; status: ArtifactLiveStatus;
    focus: string | null; cursor: ArtifactLivePosition | null; typing: ArtifactLiveTyping | null; sawLiveTurn: boolean;
  }): void {
    const now = this.clock.now();
    const room = this.ensure(input.artifactId, input.projectId);
    const id = artifactLiveAgentId(input.sessionId);
    const name = clipText(input.agentName, 128) || 'agent';
    // This process heard the newest signal: it holds the agent from now on.
    if (room.remote.delete(id)) this.dirty(room);
    const participant: ArtifactLiveParticipant = {
      id, who: { kind: 'session', session_id: input.sessionId, agent_name: name }, name, avatar_url: null,
      color: artifactLiveColor(input.sessionId), status: input.status, view: null, hidden: false,
      cursor: input.cursor, selection: null, typing: input.typing, focus: input.focus,
    };
    const agent = room.agents.get(id) ?? { participant, joinedAt: now, signalAt: now, sawLiveTurn: false, relay: { lastAt: -Infinity, cancel: null } };
    agent.participant = participant;
    agent.signalAt = now;
    agent.sawLiveTurn = input.sawLiveTurn;
    room.agents.set(id, agent);
    this.queueRelay(room, agent);
    this.dirty(room);
  }

  private agentLeave(artifactId: string, id: string, at: number, relay: boolean): void {
    const room = this.rooms.get(artifactId);
    if (room) {
      const agent = room.agents.get(id);
      if (agent) {
        agent.relay.cancel?.();
        room.agents.delete(id);
        this.promote(room);
        this.dirty(room);
      }
      const remote = room.remote.get(id);
      if (remote && (remote.at ?? 0) <= at) {
        room.remote.delete(id);
        this.dirty(room);
      }
      this.dropIfEmpty(room);
    }
    if (relay) this.relay({ k: 'rm', a: artifactId, id, at });
  }

  private remoteUp(room: Room<M>, origin: string, message: Extract<LiveRelay, { k: 'up' }>): void {
    const now = this.clock.now();
    const participant = visible(message.p);
    const local = room.agents.get(participant.id);
    if (local) {
      // One process holds an agent: the one with the newest signal (ties: the higher origin).
      const theirs = message.at ?? 0;
      if (theirs < local.signalAt || (theirs === local.signalAt && origin < this.origin)) return;
      local.relay.cancel?.();
      room.agents.delete(participant.id);
      this.dirty(room);
    }
    if (room.conns.has(participant.id) || !room.conns.size) return this.dropIfEmpty(room);
    const previous = room.remote.get(participant.id);
    if (!previous && room.remote.size >= PRESENCE_MAX) return;
    room.remote.set(participant.id, { participant, joinedAt: previous?.joinedAt ?? now, seenAt: now, origin, at: message.at ?? null });
    if (!previous || !same(previous.participant, participant)) this.dirty(room);
  }

  private remoteRm(room: Room<M>, origin: string, message: Extract<LiveRelay, { k: 'rm' }>): void {
    const previous = room.remote.get(message.id);
    // A socket's participant is removed only by its own process; an agent by any newer signal.
    if (previous && (previous.origin === origin || (message.at !== undefined && (previous.at ?? 0) <= message.at))) {
      room.remote.delete(message.id);
      this.promote(room);
      this.dirty(room);
    }
    const local = room.agents.get(message.id);
    if (local && message.at !== undefined && local.signalAt <= message.at) {
      local.relay.cancel?.();
      room.agents.delete(message.id);
      this.dirty(room);
    }
    this.dropIfEmpty(room);
  }

  private syncReply(room: Room<M>): void {
    const now = this.clock.now();
    if (now - room.syncRepliedAt < SYNC_REPLY_SPACING_MS) return;
    room.syncRepliedAt = now;
    for (const conn of room.conns.values()) if (conn.sends) this.relayNow(room, conn);
    for (const agent of room.agents.values()) this.relayNow(room, agent);
  }

  /** Over the cap no more: the oldest waiting sockets start sending. */
  private promote(room: Room<M>): void {
    const waiting = [...room.conns.values()].filter((conn) => !conn.sends).sort((a, b) => a.joinedAt - b.joinedAt);
    for (const conn of waiting) {
      if (this.listed(room) >= L.participants) return;
      conn.sends = true;
      this.sendFrame(conn.socket, { v: V, t: 'welcome', you: conn.id, sends: true });
      this.queueRelay(room, conn);
      this.dirty(room);
    }
  }

  /** Relay now when the last one is RELAY_SPACING_MS old; else once, at that time, with the state then. */
  private queueRelay(room: Room<M>, holder: Conn<M> | Agent): void {
    if (holder.relay.cancel) return;
    const wait = holder.relay.lastAt + RELAY_SPACING_MS - this.clock.now();
    if (wait <= 0) return this.relayNow(room, holder);
    holder.relay.cancel = this.clock.later(() => {
      holder.relay.cancel = null;
      this.relayNow(room, holder);
    }, wait);
  }

  private relayNow(room: Room<M>, holder: Conn<M> | Agent): void {
    holder.relay.cancel?.();
    holder.relay.cancel = null;
    const participant = holder.participant;
    if (this.rooms.get(room.artifactId) !== room) return;
    const agent = 'signalAt' in holder;
    if (agent ? room.agents.get(participant.id) !== holder : room.conns.get(participant.id) !== holder || !(holder as Conn<M>).sends) return;
    holder.relay.lastAt = this.clock.now();
    this.relay({ k: 'up', a: room.artifactId, p: visible(participant), ...(agent ? { at: holder.signalAt } : {}) });
  }

  private dirty(room: Room<M>): void {
    if (room.flushCancel) return;
    const wait = Math.max(0, room.lastFlushAt + PRESENCE_COALESCE_MS - this.clock.now());
    room.flushCancel = this.clock.later(() => {
      room.flushCancel = null;
      this.flush(room);
    }, wait);
  }

  private flush(room: Room<M>): void {
    if (this.rooms.get(room.artifactId) !== room) return;
    room.lastFlushAt = this.clock.now();
    if (!room.conns.size) return;
    const data = JSON.stringify(this.presence(room));
    for (const conn of room.conns.values()) send(conn.socket, data);
  }

  private presence(room: Room<M>): ArtifactLiveServerFrame {
    const rows: Array<{ joinedAt: number; participant: ArtifactLiveParticipant }> = [...room.agents.values(), ...room.remote.values()];
    for (const conn of room.conns.values()) if (conn.sends) rows.push({ joinedAt: conn.joinedAt, participant: conn.participant });
    rows.sort((a, b) => a.joinedAt - b.joinedAt || (a.participant.id < b.participant.id ? -1 : 1));
    return { v: V, t: 'presence', participants: rows.slice(0, PRESENCE_MAX).map((row) => visible(row.participant)) };
  }

  private sendFrame(socket: LiveSocket, frame: ArtifactLiveServerFrame): void {
    send(socket, JSON.stringify(frame));
  }
}
