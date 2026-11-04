import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from '../http/api/errors';
import type { EventStreamTimerHandle, EventStreamTimers } from '../stream/event-stream';
import {
  createArtifactLiveConnection,
  type ArtifactLiveConnectionOptions,
  type ArtifactLiveEvent,
  type ArtifactLiveWebSocket,
} from './connection';
import { ARTIFACT_LIVE_CLOSE, ARTIFACT_LIVE_LIMITS, type ArtifactLivePosition } from './protocol';

const PID = '10000000-0000-4000-8000-000000000001';
const AID = '20000000-0000-4000-8000-000000000002';
const THREAD = '30000000-0000-4000-8000-000000000003';
const USER = '40000000-0000-4000-8000-000000000004';
const { heartbeatMs } = ARTIFACT_LIVE_LIMITS;

// ── A manual clock: timers fire only when the test advances time ───────────

async function tick(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function createClock() {
  let time = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: EventStreamTimers = {
    now: () => time,
    setTimeout: (fn, ms = 0) => {
      const id = ++seq;
      pending.set(id, { at: time + ms, fn });
      return id as unknown as EventStreamTimerHandle;
    },
    clearTimeout: (handle) => {
      if (handle !== undefined) pending.delete(handle as unknown as number);
    },
  };
  async function advance(ms: number): Promise<void> {
    const target = time + ms;
    await tick();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of pending) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      pending.delete(next[0]);
      time = next[1].at;
      next[1].fn();
      await tick();
    }
    time = target;
  }
  return { timers, advance, now: () => time };
}

// ── A fake WebSocket: records sends, and the test drives open/message/close ─

interface FakeSocket {
  url: string;
  createdAt: number;
  sent: string[];
  closedWith: number | null;
  open(): void;
  receive(frame: unknown): void;
  drop(code?: number): void;
  frames(): Array<Record<string, unknown>>;
}

function createSockets(now: () => number) {
  const sockets: FakeSocket[] = [];
  class Socket {
    url: string;
    createdAt = now();
    sent: string[] = [];
    closedWith: number | null = null;
    private listeners = new Map<string, Array<(event: unknown) => void>>();
    constructor(url: string) {
      this.url = url;
      sockets.push(this as unknown as FakeSocket);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close(code?: number) {
      this.closedWith = code ?? 1000;
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    private emit(type: string, event: unknown) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    open() {
      this.emit('open', {});
    }
    receive(frame: unknown) {
      this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
    }
    drop(code = 1006) {
      this.emit('close', { code });
    }
    frames() {
      return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    }
  }
  return { sockets, WebSocket: Socket as unknown as ArtifactLiveWebSocket };
}

const welcome = (sends = true) => ({ v: 1, t: 'welcome', you: 'conn-1', sends });
const participant = (id: string) => ({
  id, who: { kind: 'user', user_id: USER }, name: 'Ada', avatar_url: null, color: 'blue', status: 'viewing', view: 'doc',
  hidden: false, cursor: null, selection: null, typing: null, focus: null,
});
const cursorAt = (offset: number): ArtifactLivePosition => ({ kind: 'doc', quote: 'Churn fell', prefix: '', offset });

let open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const connection of open) connection.close();
  open = [];
});

function setup(overrides: Partial<ArtifactLiveConnectionOptions> = {}) {
  const clock = createClock();
  const { sockets, WebSocket } = createSockets(clock.now);
  const events: ArtifactLiveEvent[] = [];
  let tickets = 0;
  const getTicket = overrides.getTicket ?? (async () => ({ ticket: `ticket-${++tickets}`, expires_at: '2026-11-04T00:01:00Z' }));
  const connection = createArtifactLiveConnection({
    projectId: PID,
    artifactId: AID,
    view: 'doc',
    version: 'etag-1',
    backendUrl: 'https://api.example.com/v1/',
    webSocket: WebSocket,
    timers: clock.timers,
    onEvent: (event) => events.push(event),
    ...overrides,
    getTicket,
  });
  open.push(connection);
  const socket = () => sockets.at(-1)!;
  /** Open the newest socket and answer its hello with a welcome. */
  const goLive = async (sends = true) => {
    await tick();
    socket().open();
    socket().receive(welcome(sends));
    await tick();
  };
  return { clock, sockets, events, connection, socket, goLive, ticketCount: () => tickets };
}

const sentOf = (socket: FakeSocket, t: string) => socket.frames().filter((frame) => frame.t === t);

describe('createArtifactLiveConnection', () => {
  test('it connects to the ws(s) URL of backendUrl with a fresh ticket and sends hello on open', async () => {
    const { socket, connection, sockets } = setup({ hidden: true });
    expect(connection.status).toBe('connecting');
    await tick();
    expect(sockets).toHaveLength(1);
    expect(socket().url).toBe(`wss://api.example.com/v1/projects/${PID}/artifacts/${AID}/live?ticket=ticket-1`);
    expect(socket().sent).toEqual([]);
    socket().open();
    expect(socket().frames()).toEqual([{ v: 1, t: 'hello', view: 'doc', version: 'etag-1', hidden: true }]);
  });

  test('an http backend gets a ws:// URL, and ids are encoded', async () => {
    const { socket } = setup({ backendUrl: 'http://localhost:8008/v1', artifactId: 'a b' });
    await tick();
    expect(socket().url).toBe(`ws://localhost:8008/v1/projects/${PID}/artifacts/a%20b/live?ticket=ticket-1`);
  });

  test('welcome makes it live and reports who this connection is', async () => {
    const { connection, events, goLive } = setup();
    await goLive(true);
    expect(connection.status).toBe('live');
    expect(connection.you).toBe('conn-1');
    expect(events).toEqual([{ type: 'welcome', you: 'conn-1', sends: true }, { type: 'status', status: 'live' }]);
  });

  test(`it pings every ${heartbeatMs / 1000} s while live`, async () => {
    const { clock, socket, goLive } = setup();
    await goLive();
    for (let beat = 1; beat <= 4; beat++) {
      await clock.advance(heartbeatMs - 1);
      expect(sentOf(socket(), 'ping')).toHaveLength(beat - 1);
      await clock.advance(1);
      expect(sentOf(socket(), 'ping')).toHaveLength(beat);
      socket().receive({ v: 1, t: 'pong' });
    }
  });

  test('a socket silent past one missed pong is dropped and replaced', async () => {
    const { clock, sockets, socket, connection, goLive } = setup();
    await goLive();
    const first = socket();
    await clock.advance(heartbeatMs);
    first.receive({ v: 1, t: 'pong' });
    await clock.advance(heartbeatMs); // ping sent, no pong
    expect(first.closedWith).toBeNull();
    await clock.advance(heartbeatMs); // still nothing received: the socket is dead
    expect(first.closedWith).not.toBeNull();
    expect(connection.status).toBe('reconnecting');
    await clock.advance(1_000);
    expect(sockets).toHaveLength(2);
  });

  test('11 cursor moves in one second send at most 10 frames, and the last position wins', async () => {
    const { clock, socket, connection, goLive } = setup();
    await goLive();
    const startedAt = clock.now();
    for (let move = 0; move < 11; move++) {
      expect(connection.setCursor(cursorAt(move))).toBe(true);
      await clock.advance(90);
    }
    await clock.advance(1_000);
    const cursors = sentOf(socket(), 'cursor');
    expect(cursors.length).toBeGreaterThan(1);
    expect(cursors.length).toBeLessThanOrEqual(10);
    expect(cursors.at(-1)).toEqual({ v: 1, t: 'cursor', at: cursorAt(10) });
    // No backlog: nothing more is sent once the latest position went out.
    await clock.advance(5_000);
    expect(sentOf(socket(), 'cursor')).toHaveLength(cursors.length);
    expect(clock.now() - startedAt).toBeGreaterThan(1_000);
  });

  test('no one-second window ever carries more than the client frame limit', async () => {
    const { clock, socket, connection, goLive } = setup();
    const sentAt: number[] = [];
    await goLive();
    let seen = socket().sent.length;
    for (let i = 0; i < 200; i++) {
      connection.setCursor(cursorAt(i % 60));
      connection.setSelection({ kind: 'doc', quote: `q${i}`, prefix: '', suffix: '' });
      connection.setTyping('doc', i % 2 === 0);
      connection.setFocus(i % 2 === 0 ? THREAD : null);
      await clock.advance(10);
      for (; seen < socket().sent.length; seen++) sentAt.push(clock.now());
    }
    await clock.advance(2_000);
    for (; seen < socket().sent.length; seen++) sentAt.push(clock.now());
    expect(sentAt.length).toBeGreaterThan(10);
    for (const start of sentAt) {
      expect(sentAt.filter((at) => at >= start && at < start + 1_000).length).toBeLessThanOrEqual(ARTIFACT_LIVE_LIMITS.clientFramesPerSecond);
    }
    // Coalescing keeps the newest value of every field.
    const last = (t: string) => sentOf(socket(), t).at(-1);
    expect(last('cursor')).toEqual({ v: 1, t: 'cursor', at: cursorAt(199 % 60) });
    expect(last('selection')).toEqual({ v: 1, t: 'selection', range: { kind: 'doc', quote: 'q199', prefix: '', suffix: '' } });
    expect(last('focus')).toEqual({ v: 1, t: 'focus', thread_id: null });
  });

  test('reconnects back off 1, 2, 4, 8, 16, 30, 30 s and fetch a fresh ticket each time', async () => {
    const { clock, sockets, events, ticketCount } = setup();
    await tick();
    const created: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      while (sockets.length <= attempt) await clock.advance(250);
      created.push(sockets[attempt]!.createdAt);
      sockets[attempt]!.drop(1006);
    }
    const gaps = created.slice(1).map((at, i) => at - created[i]!);
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(ticketCount()).toBe(8);
    expect(sockets.map((socket) => new URL(socket.url).searchParams.get('ticket'))).toEqual(
      Array.from({ length: 8 }, (_, i) => `ticket-${i + 1}`),
    );
    // A status event marks a change, not an attempt.
    expect(events).toEqual([{ type: 'status', status: 'reconnecting' }]);
  });

  test('a connection that stayed live resets the backoff to 1 s', async () => {
    const { clock, sockets, goLive } = setup();
    await tick();
    sockets[0]!.drop();
    await clock.advance(1_000);
    sockets[1]!.drop();
    await clock.advance(2_000);
    await goLive();
    await clock.advance(20_000);
    sockets[2]!.drop(1001);
    await clock.advance(999);
    expect(sockets).toHaveLength(3);
    await clock.advance(1);
    expect(sockets).toHaveLength(4);
  });

  test(`a ${ARTIFACT_LIVE_CLOSE.unauthorized} close mints a new ticket instead of reusing the old one`, async () => {
    const { clock, sockets, goLive } = setup();
    await goLive();
    sockets[0]!.drop(ARTIFACT_LIVE_CLOSE.unauthorized);
    await clock.advance(1_000);
    expect(sockets).toHaveLength(2);
    expect(new URL(sockets[1]!.url).searchParams.get('ticket')).toBe('ticket-2');
  });

  test(`a ${ARTIFACT_LIVE_CLOSE.accessLost} close stops for good and reports access_lost`, async () => {
    const { clock, sockets, events, connection, goLive, ticketCount } = setup();
    await goLive();
    sockets[0]!.receive({ v: 1, t: 'presence', participants: [participant('conn-1')] });
    expect(connection.participants).toHaveLength(1);
    sockets[0]!.drop(ARTIFACT_LIVE_CLOSE.accessLost);
    expect(connection.status).toBe('access_lost');
    expect(connection.participants).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'status', status: 'access_lost' });
    await clock.advance(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(ticketCount()).toBe(1);
    expect(connection.setCursor(cursorAt(1))).toBe(false);
  });

  test('every 403 or 404 from the ticket route is access_lost, whatever its code; a 5xx is retried', async () => {
    for (const [status, code] of [[403, 'artifact_comment_forbidden'], [403, 'feature_disabled'], [403, undefined], [404, undefined]] as const) {
      let calls = 0;
      const { clock, connection, sockets } = setup({ getTicket: async () => { calls++; throw new ApiError('No', { status, code }); } });
      await tick();
      expect({ status, code, result: connection.status }).toEqual({ status, code, result: 'access_lost' });
      await clock.advance(10 * 60_000);
      expect(sockets).toHaveLength(0);
      expect(calls).toBe(1);
    }
    let calls = 0;
    const { clock, connection, sockets } = setup({
      getTicket: async () => {
        calls++;
        if (calls === 1) throw new ApiError('Unavailable', { status: 503 });
        return 'plain-ticket';
      },
    });
    await tick();
    expect(connection.status).toBe('reconnecting');
    await clock.advance(1_000);
    expect(sockets).toHaveLength(1);
    expect(new URL(sockets[0]!.url).searchParams.get('ticket')).toBe('plain-ticket');
  });

  test('invalid server frames are dropped', async () => {
    const { socket, events, connection, goLive } = setup();
    await goLive();
    events.length = 0;
    socket().receive('{not json');
    socket().receive({ v: 1, t: 'presence', participants: [{ ...participant('x'), color: 'pink' }] });
    socket().receive({ v: 1, t: 'changed', what: 'secrets', version: null });
    socket().receive({ v: 2, t: 'pong' });
    socket().receive({ v: 1, t: 'welcome', you: 'someone-else', sends: true, extra: 1 });
    expect(events).toEqual([]);
    expect(connection.participants).toEqual([]);
    expect(connection.you).toBe('conn-1');
    socket().receive({ v: 1, t: 'presence', participants: [participant('conn-1'), participant('conn-2')] });
    socket().receive({ v: 1, t: 'changed', what: 'comments', version: null });
    expect(events.map((event) => event.type)).toEqual(['presence', 'changed']);
    expect(connection.participants.map((p) => p.id)).toEqual(['conn-1', 'conn-2']);
    expect(events[1]).toEqual({ type: 'changed', what: 'comments', version: null });
  });

  test('a reconnect emits resync once it is live again, and restores this viewer\'s state', async () => {
    const { clock, sockets, events, connection, goLive } = setup();
    await goLive();
    expect(events.some((event) => event.type === 'resync')).toBe(false);
    connection.setFocus(THREAD);
    connection.setCursor(cursorAt(3));
    connection.setTyping({ thread_id: THREAD }, true);
    await clock.advance(1_000);
    sockets[0]!.drop(1006);
    await clock.advance(1_000);
    await goLive();
    expect(events.filter((event) => event.type === 'resync')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'resync' });
    await clock.advance(1_000);
    expect(sockets[1]!.frames()).toEqual([
      { v: 1, t: 'hello', view: 'doc', version: 'etag-1', hidden: false },
      { v: 1, t: 'cursor', at: cursorAt(3) },
      { v: 1, t: 'typing', where: { thread_id: THREAD }, active: true },
      { v: 1, t: 'focus', thread_id: THREAD },
    ]);
  });

  test('a first connection that needed retries also emits resync', async () => {
    const { clock, sockets, events, goLive } = setup();
    await tick();
    sockets[0]!.drop(1006);
    await clock.advance(1_000);
    await goLive();
    expect(events.filter((event) => event.type === 'resync')).toHaveLength(1);
  });

  test('sends: false keeps pinging but never sends presence frames', async () => {
    const { clock, socket, connection, goLive } = setup();
    await goLive(false);
    expect(connection.setCursor(cursorAt(1))).toBe(true);
    connection.setFocus(THREAD);
    connection.setHidden(true);
    await clock.advance(heartbeatMs);
    expect(socket().frames().map((frame) => frame.t)).toEqual(['hello', 'ping']);
  });

  test('a later welcome with sends: true promotes the socket: it sends what was set, then every new value', async () => {
    const { clock, socket, events, connection, goLive } = setup();
    await goLive(false);
    expect(connection.setCursor(cursorAt(1))).toBe(true);
    await clock.advance(1_000);
    expect(sentOf(socket(), 'cursor')).toEqual([]);
    socket().receive({ v: 1, t: 'welcome', you: 'conn-1b', sends: true });
    await clock.advance(1_000);
    expect(connection.you).toBe('conn-1b');
    expect(sentOf(socket(), 'cursor')).toEqual([{ v: 1, t: 'cursor', at: cursorAt(1) }]);
    connection.setCursor(cursorAt(2));
    await clock.advance(1_000);
    expect(sentOf(socket(), 'cursor').at(-1)).toEqual({ v: 1, t: 'cursor', at: cursorAt(2) });
    // A promotion is not a reconnect: no resync, no second status change.
    expect(events.filter((event) => event.type === 'resync' || event.type === 'status')).toEqual([{ type: 'status', status: 'live' }]);
    expect(events.filter((event) => event.type === 'welcome').at(-1)).toEqual({ type: 'welcome', you: 'conn-1b', sends: true });
  });

  test('a later welcome with sends: false stops presence frames', async () => {
    const { clock, socket, connection, goLive } = setup();
    await goLive(true);
    // The hello just went out, so this cursor waits for the next send slot.
    connection.setCursor(cursorAt(3));
    socket().receive({ v: 1, t: 'welcome', you: 'conn-1', sends: false });
    connection.setCursor(cursorAt(4));
    await clock.advance(1_000);
    expect(sentOf(socket(), 'cursor')).toEqual([]);
  });

  test('setHidden sends hide, and the next hello carries it', async () => {
    const { clock, sockets, connection, goLive } = setup();
    await goLive();
    connection.setHidden(true);
    await clock.advance(200);
    expect(sentOf(sockets[0]!, 'hide')).toEqual([{ v: 1, t: 'hide', hidden: true }]);
    sockets[0]!.drop(1006);
    await clock.advance(1_000);
    sockets[1]!.open();
    expect(sockets[1]!.frames()[0]).toEqual({ v: 1, t: 'hello', view: 'doc', version: 'etag-1', hidden: true });
  });

  test('setHidden with the value the hello carried sends nothing', async () => {
    const { clock, socket, connection, goLive } = setup({ hidden: true });
    await goLive();
    expect(connection.setHidden(true)).toBe(true);
    await clock.advance(1_000);
    expect(socket().frames().map((frame) => frame.t)).toEqual(['hello']);
  });

  test('a value the protocol refuses is never sent', async () => {
    const { clock, socket, connection, goLive } = setup();
    await goLive();
    expect(connection.setCursor({ kind: 'doc', quote: 'q'.repeat(65), prefix: '', offset: 0 })).toBe(false);
    expect(connection.setSelection({ kind: 'doc', quote: '€'.repeat(450), prefix: '', suffix: '' })).toBe(false);
    expect(connection.setFocus('not-a-uuid')).toBe(false);
    expect(connection.setTyping({ thread_id: 'nope' }, true)).toBe(false);
    await clock.advance(1_000);
    expect(socket().frames().map((frame) => frame.t)).toEqual(['hello']);
  });

  test('an unchanged value is not sent again', async () => {
    const { clock, socket, connection, goLive } = setup();
    await goLive();
    connection.setFocus(THREAD);
    await clock.advance(500);
    connection.setFocus(THREAD);
    await clock.advance(500);
    expect(sentOf(socket(), 'focus')).toHaveLength(1);
  });

  test('a socket that never welcomes is replaced after the connect timeout', async () => {
    const { clock, sockets } = setup();
    await tick();
    sockets[0]!.open();
    await clock.advance(19_999);
    expect(sockets[0]!.closedWith).toBeNull();
    await clock.advance(1);
    expect(sockets[0]!.closedWith).not.toBeNull();
    await clock.advance(1_000);
    expect(sockets).toHaveLength(2);
  });

  test('close sends bye, closes the socket and never reconnects', async () => {
    const { clock, sockets, connection, events, goLive } = setup();
    await goLive();
    connection.close();
    expect(sockets[0]!.frames().at(-1)).toEqual({ v: 1, t: 'bye' });
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(connection.status).toBe('closed');
    expect(events.at(-1)).toEqual({ type: 'status', status: 'closed' });
    sockets[0]!.drop(1000);
    await clock.advance(60_000);
    expect(sockets).toHaveLength(1);
    connection.close();
    expect(events.filter((event) => event.type === 'status' && event.status === 'closed')).toHaveLength(1);
  });

  test('close during the ticket request opens no socket', async () => {
    let release!: (ticket: string) => void;
    const { clock, sockets, connection } = setup({ getTicket: () => new Promise<string>((resolve) => { release = resolve; }) });
    await tick();
    connection.close();
    release('late-ticket');
    await clock.advance(60_000);
    expect(sockets).toHaveLength(0);
  });

  test('without a WebSocket in the runtime it throws a clear error', () => {
    const original = globalThis.WebSocket;
    try {
      (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
      expect(() => createArtifactLiveConnection({ projectId: PID, artifactId: AID, view: 'doc', getTicket: async () => 't' })).toThrow(/WebSocket/);
    } finally {
      globalThis.WebSocket = original;
    }
  });

  test('the global WebSocket type fits the injected constructor', () => {
    const ctor: ArtifactLiveWebSocket = WebSocket;
    expect(typeof ctor).toBe('function');
  });
});
