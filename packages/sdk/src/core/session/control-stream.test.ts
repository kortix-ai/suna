import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureKortix } from '../http/config';
import type { RuntimeEventMessage } from '../runtime/runtime-rest-client';
import {
  __resetSessionControlStreamsForTests,
  openSessionControlStream,
} from './control-stream';

/** One connection the fake transport holds open until the test ends it. */
interface FakeConnection {
  url: string;
  auth: string | null;
  signal: AbortSignal;
  push: (frame: Record<string, unknown>, id?: string) => void;
  end: () => void;
}

let connections: FakeConnection[] = [];

function fakeTransport() {
  return async function* (request: { url: string; headers: Headers; signal: AbortSignal }) {
    const pending: Array<RuntimeEventMessage | 'end'> = [];
    let wake: () => void = () => {};
    const connection: FakeConnection = {
      url: request.url,
      auth: request.headers.get('authorization'),
      signal: request.signal,
      push: (frame, id) => {
        pending.push({ data: JSON.stringify(frame), ...(id ? { id } : {}) });
        wake();
      },
      end: () => {
        pending.push('end');
        wake();
      },
    };
    connections.push(connection);
    request.signal.addEventListener('abort', () => connection.end());
    while (true) {
      if (pending.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      const next = pending.shift()!;
      if (next === 'end') return;
      yield next;
    }
  };
}

const TIMING = { backoffMs: [5, 10], livenessMs: 80 };
const hello = { type: 'kortix.stream.hello', channel: 'stream' };
const heartbeat = { type: 'kortix.stream.heartbeat', channel: 'stream' };
const queueFrame = (cseq: number, prompts: unknown[], cepoch = 'capi_a') => ({
  channel: 'control',
  cepoch,
  cseq,
  type: 'kortix.control.queue',
  at: 1,
  payload: { known: true, prompts, held: false, observed_at: '2026-10-06T10:00:00.000Z' },
});

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  connections = [];
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'tok',
    eventStreamTransport: fakeTransport(),
  });
});

afterEach(() => __resetSessionControlStreamsForTests());

test('opens the control-only stream with the platform auth and hands each queue frame over', async () => {
  const queues: unknown[] = [];
  const states: boolean[] = [];
  const stream = openSessionControlStream({
    projectId: 'p1',
    sessionId: 's1',
    onQueue: (queue) => queues.push(queue),
    onConnectionChange: (connected) => states.push(connected),
    timing: TIMING,
  });
  await tick();
  expect(connections).toHaveLength(1);
  expect(connections[0]!.url).toBe('http://backend.test/v1/projects/p1/sessions/s1/events?channels=control');
  expect(connections[0]!.auth).toBe('Bearer tok');
  expect(states).toEqual([]);

  connections[0]!.push(hello);
  await tick();
  expect(states).toEqual([true]);
  expect(stream.connected()).toBe(true);

  connections[0]!.push(queueFrame(1, [{ prompt_id: 'q1' }]));
  connections[0]!.push({ channel: 'control', cepoch: 'capi_a', cseq: 2, type: 'kortix.control.turn', payload: {} });
  await tick();
  expect(queues).toEqual([
    { known: true, prompts: [{ prompt_id: 'q1' }], held: false, observed_at: '2026-10-06T10:00:00.000Z' },
  ]);
  stream.close();
});

test('every opener of one session shares ONE connection; the last close ends it', async () => {
  const a: string[] = [];
  const b: string[] = [];
  const first = openSessionControlStream({ projectId: 'p1', sessionId: 's1', onQueue: () => a.push('q'), timing: TIMING });
  await tick();
  connections[0]!.push(hello);
  await tick();
  const lateStates: boolean[] = [];
  const second = openSessionControlStream({
    projectId: 'p1',
    sessionId: 's1',
    onQueue: () => b.push('q'),
    onConnectionChange: (connected) => lateStates.push(connected),
  });
  await tick();
  expect(connections).toHaveLength(1);
  // A late opener is told the stream it joined is already connected.
  expect(lateStates).toEqual([true]);

  connections[0]!.push(queueFrame(1, []));
  await tick();
  expect([a.length, b.length]).toEqual([1, 1]);

  first.close();
  await tick();
  expect(connections[0]!.signal.aborted).toBe(false);
  second.close();
  await tick();
  expect(connections[0]!.signal.aborted).toBe(true);
  await tick(30);
  expect(connections).toHaveLength(1);
});

test('a dropped stream reports disconnected, then resumes at its control cursor', async () => {
  const states: boolean[] = [];
  const stream = openSessionControlStream({
    projectId: 'p1',
    sessionId: 's1',
    onConnectionChange: (connected) => states.push(connected),
    timing: TIMING,
  });
  await tick();
  connections[0]!.push(hello);
  connections[0]!.push(queueFrame(7, [], 'capi a/b'));
  await tick();
  connections[0]!.end();
  await tick(20);
  expect(states).toEqual([true, false]);
  expect(connections).toHaveLength(2);
  expect(connections[1]!.url).toBe(
    'http://backend.test/v1/projects/p1/sessions/s1/events?channels=control&since_control=7&cepoch=capi+a%2Fb',
  );
  connections[1]!.push(hello);
  await tick();
  expect(states).toEqual([true, false, true]);
  stream.close();
});

test('a resync drops the cursor: the next connection asks for a full snapshot', async () => {
  const stream = openSessionControlStream({ projectId: 'p1', sessionId: 's1', timing: TIMING });
  await tick();
  connections[0]!.push(hello);
  connections[0]!.push(queueFrame(3, []));
  connections[0]!.push({ channel: 'control', type: 'kortix.control.resync', cepoch: 'capi_b' });
  await tick();
  connections[0]!.end();
  await tick(20);
  expect(connections[1]!.url).toBe('http://backend.test/v1/projects/p1/sessions/s1/events?channels=control');
  stream.close();
});

test('heartbeats keep a quiet stream alive; silence past the liveness bound reconnects', async () => {
  const states: boolean[] = [];
  const stream = openSessionControlStream({
    projectId: 'p1',
    sessionId: 's1',
    onConnectionChange: (connected) => states.push(connected),
    timing: TIMING,
  });
  await tick();
  connections[0]!.push(hello);
  for (let i = 0; i < 4; i++) {
    await tick(40);
    connections[0]!.push(heartbeat);
  }
  await tick();
  expect(connections).toHaveLength(1);
  expect(states).toEqual([true]);

  await tick(120);
  expect(connections[0]!.signal.aborted).toBe(true);
  expect(states).toEqual([true, false]);
  expect(connections.length).toBeGreaterThanOrEqual(2);
  stream.close();
});

test('a failing connect backs off and retries', async () => {
  let attempts = 0;
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'tok',
    // eslint-disable-next-line require-yield
    eventStreamTransport: async function* () {
      attempts += 1;
      throw Object.assign(new Error('SSE failed: 503'), { status: 503 });
    },
  });
  const states: boolean[] = [];
  const stream = openSessionControlStream({
    projectId: 'p1',
    sessionId: 's1',
    onConnectionChange: (connected) => states.push(connected),
    timing: TIMING,
  });
  await tick(60);
  stream.close();
  expect(attempts).toBeGreaterThanOrEqual(3);
  // Never connected, so never reported as lost either.
  expect(states).toEqual([]);
});
