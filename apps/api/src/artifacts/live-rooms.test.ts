import { beforeEach, describe, expect, test } from 'bun:test';
import { ARTIFACT_LIVE_CLOSE, ARTIFACT_LIVE_LIMITS, type ArtifactLiveParticipant } from '@kortix/shared/artifact-live';
import { ArtifactLiveRooms, PRESENCE_COALESCE_MS, RELAY_SPACING_MS, type LiveIdentity, type LiveRelay } from './live-rooms';

const L = ARTIFACT_LIVE_LIMITS;
const A = '50000000-0000-4000-8000-00000000000a';
const P = '50000000-0000-4000-8000-00000000000b';
const THREAD = '50000000-0000-4000-8000-00000000000c';
const SESSION = '50000000-0000-4000-8000-00000000000d';
const user = (n: number): LiveIdentity => ({
  who: { kind: 'user', user_id: `50000000-0000-4000-8000-${String(n).padStart(12, '0')}` }, name: `Person ${n}`, avatar_url: null,
});

/** Timers run only when the test advances the clock. */
class FakeClock {
  t = 1_000_000;
  private seq = 0;
  private timers: Array<{ at: number; seq: number; run: () => void }> = [];
  now = () => this.t;
  later = (run: () => void, ms: number) => {
    const timer = { at: this.t + ms, seq: this.seq++, run };
    this.timers.push(timer);
    return () => { this.timers = this.timers.filter((t) => t !== timer); };
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = Math.max(this.t, due.at);
      due.run();
    }
    this.t = end;
  }
}

type Frame = { t: string; [key: string]: any };
class FakeSocket {
  frames: Frame[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
  of(t: string) { return this.frames.filter((f) => f.t === t); }
  lastPresence(): ArtifactLiveParticipant[] { return this.of('presence').at(-1)?.participants ?? []; }
}

let clock: FakeClock;
let relayed: LiveRelay[];
let rooms: ArtifactLiveRooms<null>;
let ids: number;
const frame = (value: Record<string, unknown>) => JSON.stringify({ v: 1, ...value });
const join = (socket: FakeSocket, n = 1) => rooms.join({ artifactId: A, projectId: P, socket, identity: user(n), meta: null });
const ups = () => relayed.filter((r): r is Extract<LiveRelay, { k: 'up' }> => r.k === 'up');

beforeEach(() => {
  clock = new FakeClock();
  relayed = [];
  ids = 0;
  rooms = new ArtifactLiveRooms({ clock, relay: (message) => relayed.push(message), origin: 'pod-a', newId: () => `c${++ids}` });
});

describe('joining a room', () => {
  test('a socket gets welcome, then the presence list with itself; the first socket asks the other replicas to sync', () => {
    const socket = new FakeSocket();
    expect(join(socket)).toEqual({ id: 'c1', sends: true });
    expect(socket.frames[0]).toEqual({ v: 1, t: 'welcome', you: 'c1', sends: true });
    expect(socket.frames[1]!.t).toBe('presence');
    expect(socket.lastPresence().map((p) => p.id)).toEqual(['c1']);
    expect(socket.lastPresence()[0]).toMatchObject({ status: 'viewing', hidden: false, cursor: null, name: 'Person 1' });
    expect(relayed[0]).toEqual({ k: 'sync', a: A });
  });

  test('each socket sees the other in presence', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    join(a, 1);
    join(b, 2);
    clock.advance(PRESENCE_COALESCE_MS);
    expect(a.lastPresence().map((p) => p.id)).toEqual(['c1', 'c2']);
    expect(b.lastPresence().map((p) => p.id)).toEqual(['c1', 'c2']);
  });
});

describe('frame limits', () => {
  test(`at most ${L.clientFramesPerSecond} frames per second are applied; the rest are dropped`, () => {
    const socket = new FakeSocket();
    join(socket);
    for (let i = 0; i < 15; i++) rooms.receive(A, 'c1', frame({ t: 'ping' }));
    expect(socket.of('pong')).toHaveLength(L.clientFramesPerSecond);
    clock.advance(1_000);
    rooms.receive(A, 'c1', frame({ t: 'ping' }));
    expect(socket.of('pong')).toHaveLength(L.clientFramesPerSecond + 1);
    expect(socket.closed).toBeNull();
  });

  test('sustained abuse closes the socket with 4429', () => {
    const socket = new FakeSocket();
    join(socket);
    for (let tick = 0; tick < 100 && !socket.closed; tick++) {
      for (let i = 0; i < 2; i++) rooms.receive(A, 'c1', frame({ t: 'ping' }));
      clock.advance(50);
    }
    expect(socket.closed?.code).toBe(ARTIFACT_LIVE_CLOSE.rateLimited);
  });

  test(`a frame over ${L.frameBytes} bytes, a malformed frame and a wrong version close with 4400`, () => {
    for (const raw of [frame({ t: 'cursor', at: { kind: 'doc', quote: 'x'.repeat(64), prefix: 'y'.repeat(32), offset: 0 }, pad: 'z'.repeat(L.frameBytes) }), '{nope', JSON.stringify({ v: 2, t: 'ping' })]) {
      const socket = new FakeSocket();
      const { id } = join(socket);
      rooms.receive(A, id, raw);
      expect(socket.closed?.code).toBe(ARTIFACT_LIVE_CLOSE.protocol);
    }
  });
});

describe('presence and relays', () => {
  test(`presence to the room is coalesced to one frame per ${PRESENCE_COALESCE_MS} ms and carries the newest cursor`, () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    join(a, 1);
    join(b, 2);
    clock.advance(PRESENCE_COALESCE_MS);
    const before = b.of('presence').length;
    for (let i = 0; i < 10; i++) {
      rooms.receive(A, 'c1', frame({ t: 'cursor', at: { kind: 'page', selector: '#cta', x: i / 10, y: 0.5 } }));
      clock.advance(10);
    }
    clock.advance(PRESENCE_COALESCE_MS);
    const sent = b.of('presence').length - before;
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(sent).toBeLessThanOrEqual(2);
    expect(b.lastPresence().find((p) => p.id === 'c1')?.cursor).toEqual({ kind: 'page', selector: '#cta', x: 0.9, y: 0.5 });
  });

  test(`a socket's cursor reaches other replicas at most ${L.relayFramesPerSecond} times per second, ending on the newest`, () => {
    const socket = new FakeSocket();
    join(socket);
    clock.advance(1_000);
    relayed = [];
    for (let i = 0; i < 20; i++) {
      rooms.receive(A, 'c1', frame({ t: 'cursor', at: { kind: 'page', selector: '#cta', x: i / 20, y: 0 } }));
      clock.advance(100);
    }
    clock.advance(RELAY_SPACING_MS);
    const cursorUps = ups();
    expect(cursorUps.length).toBeLessThanOrEqual(2 * L.relayFramesPerSecond + 1);
    expect(cursorUps.at(-1)!.p.cursor).toEqual({ kind: 'page', selector: '#cta', x: 19 / 20, y: 0 });
  });

  test('a hidden participant keeps its avatar and never relays a cursor, selection or typing', () => {
    const a = new FakeSocket();
    join(a, 1);
    rooms.receive(A, 'c1', frame({ t: 'hello', view: 'doc', version: null, hidden: true }));
    rooms.receive(A, 'c1', frame({ t: 'cursor', at: { kind: 'doc', quote: 'Churn fell', prefix: '', offset: 2 } }));
    rooms.receive(A, 'c1', frame({ t: 'selection', range: { kind: 'doc', quote: 'Churn fell', prefix: '', suffix: '' } }));
    rooms.receive(A, 'c1', frame({ t: 'typing', where: 'doc', active: true }));
    clock.advance(1_000);
    const me = a.lastPresence().find((p) => p.id === 'c1')!;
    expect(me).toMatchObject({ hidden: true, view: 'doc', cursor: null, selection: null, typing: null });
    expect(ups().every((up) => up.p.cursor === null && up.p.selection === null && up.p.typing === null)).toBe(true);
    // Showing again, then hiding, clears what was drawn.
    rooms.receive(A, 'c1', frame({ t: 'hide', hidden: false }));
    rooms.receive(A, 'c1', frame({ t: 'cursor', at: { kind: 'doc', quote: 'Churn fell', prefix: '', offset: 2 } }));
    clock.advance(1_000);
    expect(a.lastPresence()[0]!.cursor).not.toBeNull();
    rooms.receive(A, 'c1', frame({ t: 'hide', hidden: true }));
    clock.advance(1_000);
    expect(a.lastPresence()[0]).toMatchObject({ hidden: true, cursor: null });
    // A hidden participant from another replica is stripped here too.
    rooms.remote('pod-b', { k: 'up', a: A, p: { ...a.lastPresence()[0]!, id: 'r1', hidden: true, cursor: { kind: 'doc', quote: 'x', prefix: '', offset: 0 } } });
    clock.advance(1_000);
    expect(a.lastPresence().find((p) => p.id === 'r1')?.cursor).toBeNull();
  });

  test('a content change pings every socket; a hello with an older version gets one at once', () => {
    const a = new FakeSocket();
    join(a, 1);
    rooms.changed(A, 'content', 'etag-2');
    expect(a.of('changed').at(-1)).toEqual({ v: 1, t: 'changed', what: 'content', version: 'etag-2' });
    const b = new FakeSocket();
    join(b, 2);
    rooms.receive(A, 'c2', frame({ t: 'hello', view: 'doc', version: 'etag-1' }));
    expect(b.of('changed')).toEqual([{ v: 1, t: 'changed', what: 'content', version: 'etag-2' }]);
  });
});

describe('expiry', () => {
  test(`a socket silent for ${L.expireMs} ms is closed and leaves; a pinging one stays`, () => {
    const quiet = new FakeSocket();
    const live = new FakeSocket();
    join(quiet, 1);
    join(live, 2);
    clock.advance(30_000);
    rooms.receive(A, 'c2', frame({ t: 'ping' }));
    clock.advance(L.expireMs - 30_000 + 1);
    rooms.sweep();
    clock.advance(PRESENCE_COALESCE_MS);
    expect(quiet.closed?.code).toBe(1000);
    expect(live.closed).toBeNull();
    expect(live.lastPresence().map((p) => p.id)).toEqual(['c2']);
    expect(relayed.some((r) => r.k === 'rm' && r.id === 'c1')).toBe(true);
  });

  test('a participant from another replica expires when its replica stops refreshing it', () => {
    const socket = new FakeSocket();
    join(socket);
    rooms.remote('pod-b', { k: 'up', a: A, p: { ...socket.lastPresence()[0]!, id: 'r1' } });
    clock.advance(L.expireMs);
    rooms.sweep();
    clock.advance(PRESENCE_COALESCE_MS);
    expect(socket.lastPresence().map((p) => p.id)).toContain('r1');
    rooms.receive(A, 'c1', frame({ t: 'ping' }));
    clock.advance(1);
    rooms.sweep();
    clock.advance(PRESENCE_COALESCE_MS);
    expect(socket.lastPresence().map((p) => p.id)).toEqual(['c1']);
  });

  test('local participants are re-sent to other replicas before they would expire there', () => {
    const socket = new FakeSocket();
    join(socket);
    relayed = [];
    for (let s = 0; s < 60; s += 5) {
      clock.advance(5_000);
      rooms.receive(A, 'c1', frame({ t: 'ping' }));
      rooms.sweep();
    }
    expect(ups().length).toBeGreaterThanOrEqual(Math.floor(60_000 / L.expireMs) + 1);
  });
});

describe(`the ${L.participants}-participant cap`, () => {
  test('a socket beyond the cap sees presence but sends none, and joins when a place frees', () => {
    const sockets = Array.from({ length: L.participants }, () => new FakeSocket());
    sockets.forEach((socket, i) => join(socket, i + 1));
    const late = new FakeSocket();
    expect(join(late, 99)).toEqual({ id: `c${L.participants + 1}`, sends: false });
    clock.advance(PRESENCE_COALESCE_MS);
    rooms.receive(A, `c${L.participants + 1}`, frame({ t: 'hello', view: 'page', version: null, hidden: true }));
    rooms.receive(A, `c${L.participants + 1}`, frame({ t: 'cursor', at: { kind: 'page', selector: 'p', x: 0, y: 0 } }));
    rooms.receive(A, `c${L.participants + 1}`, frame({ t: 'ping' }));
    clock.advance(PRESENCE_COALESCE_MS);
    expect(late.lastPresence()).toHaveLength(L.participants);
    expect(late.lastPresence().some((p) => p.id === `c${L.participants + 1}`)).toBe(false);
    expect(late.of('pong')).toHaveLength(1);
    rooms.leave(A, 'c1');
    expect(late.of('welcome').at(-1)).toEqual({ v: 1, t: 'welcome', you: `c${L.participants + 1}`, sends: true });
    clock.advance(PRESENCE_COALESCE_MS);
    // It lists with the hello it sent while waiting: hidden, so no cursor.
    expect(late.lastPresence().find((p) => p.id === `c${L.participants + 1}`)).toMatchObject({ view: 'page', hidden: true, cursor: null });
  });
});

describe('agent presence', () => {
  const agent = () => ({ artifactId: A, projectId: P, sessionId: SESSION, agentName: 'writer' });
  const seen = (socket: FakeSocket) => socket.lastPresence().find((p) => p.who.kind === 'session');

  test('reading, editing near a quote, writing in a thread, a reply lands, then idle leaves', () => {
    const socket = new FakeSocket();
    join(socket);
    rooms.agentSignal({ ...agent(), signal: { status: 'editing', thread_id: THREAD } });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toMatchObject({
      id: `session:${SESSION}`, who: { kind: 'session', session_id: SESSION, agent_name: 'writer' }, name: 'writer',
      status: 'editing', focus: THREAD, cursor: null, typing: null,
    });
    rooms.agentSignal({ ...agent(), signal: { status: 'editing', quote: 'q'.repeat(80) } });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)!.cursor).toEqual({ kind: 'doc', quote: 'q'.repeat(64), prefix: '', offset: 0 });
    rooms.agentSignal({ ...agent(), signal: { status: 'writing', thread_id: THREAD } });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toMatchObject({ status: 'writing', typing: { thread_id: THREAD } });
    rooms.agentSignal({ ...agent(), signal: { status: 'writing', quote: 'Churn' } });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toMatchObject({ status: 'writing', typing: 'doc' });
    rooms.agentWrote(A, SESSION);
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toMatchObject({ status: 'editing', typing: null });
    rooms.agentSignal({ ...agent(), signal: { status: 'idle' } });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toBeUndefined();
    expect(relayed.some((r) => r.k === 'rm' && r.id === `session:${SESSION}`)).toBe(true);
  });

  test('a quote is cut to 64 UTF-16 units without splitting a surrogate pair', () => {
    const socket = new FakeSocket();
    join(socket);
    rooms.agentSignal({ ...agent(), signal: { status: 'editing', quote: `${'a'.repeat(63)}😀tail` } });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)!.cursor).toEqual({ kind: 'doc', quote: 'a'.repeat(63), prefix: '', offset: 0 });
  });

  test(`an agent with no signal for ${L.agentIdleMs} ms leaves, writing included`, () => {
    const socket = new FakeSocket();
    join(socket);
    rooms.agentSignal({ ...agent(), signal: { status: 'writing', thread_id: THREAD } });
    for (let s = 0; s < L.agentIdleMs; s += 20_000) {
      clock.advance(20_000);
      rooms.receive(A, 'c1', frame({ t: 'ping' }));
      rooms.sweep();
    }
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toMatchObject({ status: 'writing' });
    clock.advance(1);
    rooms.sweep();
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toBeUndefined();
  });

  test('a delivered hand-off shows the agent reading at the thread; it leaves when the turn that followed ends', () => {
    const socket = new FakeSocket();
    join(socket);
    const cursor = { kind: 'doc' as const, quote: 'Churn fell', prefix: 'Q3 ', offset: 0 };
    rooms.agentDelivered({ ...agent(), threadId: THREAD, cursor });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toMatchObject({ status: 'reading', focus: THREAD, cursor });
    rooms.sessionTurn(SESSION, false);
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toBeDefined();
    rooms.sessionTurn(SESSION, true);
    rooms.sessionTurn(SESSION, false);
    clock.advance(PRESENCE_COALESCE_MS);
    expect(seen(socket)).toBeUndefined();
  });
});

describe('across replicas', () => {
  test('another replica\'s participant shows here; only its own replica removes it', () => {
    const socket = new FakeSocket();
    join(socket);
    const remote = { ...socket.lastPresence()[0]!, id: 'r1', name: 'Remote' };
    rooms.remote('pod-b', { k: 'up', a: A, p: remote });
    rooms.remote('pod-a', { k: 'rm', a: A, id: 'c1' });
    rooms.remote('pod-c', { k: 'rm', a: A, id: 'r1' });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(socket.lastPresence().map((p) => p.id)).toEqual(['c1', 'r1']);
    rooms.remote('pod-b', { k: 'rm', a: A, id: 'r1' });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(socket.lastPresence().map((p) => p.id)).toEqual(['c1']);
  });

  test('a sync request re-sends every local participant at most once a second', () => {
    const socket = new FakeSocket();
    join(socket);
    rooms.agentSignal({ artifactId: A, projectId: P, sessionId: SESSION, agentName: 'writer', signal: { status: 'reading' } });
    clock.advance(1_000);
    relayed = [];
    rooms.remote('pod-b', { k: 'sync', a: A });
    rooms.remote('pod-b', { k: 'sync', a: A });
    expect(ups().map((up) => up.p.id).sort()).toEqual(['c1', `session:${SESSION}`]);
  });

  test('the newer agent signal owns the agent; a later idle anywhere removes it', () => {
    const socket = new FakeSocket();
    join(socket);
    rooms.agentSignal({ artifactId: A, projectId: P, sessionId: SESSION, agentName: 'writer', signal: { status: 'reading' } });
    const ours = ups().at(-1)!;
    // An older signal from pod-b loses; a newer one takes the agent over.
    rooms.remote('pod-b', { k: 'up', a: A, p: { ...ours.p, status: 'writing' }, at: ours.at! - 1 });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(socket.lastPresence().find((p) => p.id === ours.p.id)?.status).toBe('reading');
    rooms.remote('pod-b', { k: 'up', a: A, p: { ...ours.p, status: 'editing' }, at: ours.at! + 5 });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(socket.lastPresence().find((p) => p.id === ours.p.id)?.status).toBe('editing');
    rooms.remote('pod-c', { k: 'rm', a: A, id: ours.p.id, at: ours.at! + 10 });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(socket.lastPresence().some((p) => p.id === ours.p.id)).toBe(false);
  });

  test('its own echo is ignored', () => {
    const socket = new FakeSocket();
    join(socket);
    rooms.remote('pod-a', { k: 'up', a: A, p: { ...socket.lastPresence()[0]!, id: 'echo' } });
    clock.advance(PRESENCE_COALESCE_MS);
    expect(socket.lastPresence().map((p) => p.id)).toEqual(['c1']);
  });
});
