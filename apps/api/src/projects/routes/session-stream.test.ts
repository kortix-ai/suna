/**
 * GET /v1/projects/:projectId/sessions/:sessionId/stream — the multiplexer.
 *
 * Driven through the real Hono app and read as REAL SSE BYTES, because every
 * claim here is about what a client receives on the wire. The daemon is a fake
 * whose frames are written by the test, so what this file falsifies is the
 * route's own contract:
 *
 *   1. the daemon's `seq` is FORWARDED, never renumbered, and never mixed with
 *      the control channel's `cseq`;
 *   2. a box that is stopped, missing or unreachable produces a 200 stream that
 *      keeps delivering control events and says the runtime is down;
 *   3. a reconnect replays exactly what was missed, and an unreplayable cursor
 *      produces a typed resync rather than silence;
 *   4. the `id:` field carries BOTH cursors, so a `Last-Event-ID` reconnect
 *      restores the same position an explicit query would.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';
// Imported BEFORE the `mock.module` below replaces the module: the fake daemon
// answers with real SSE bytes, so the route must keep the real parser.
import { parseSseFrames as realParseSseFrames } from '../lib/session-runtime-transport';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';

let loadedProject: { row: Record<string, unknown>; userId: string } | null = null;
let visibleSession: Record<string, unknown> | null = null;

/** The sandbox row the pump reads before every attach attempt. */
let sandboxRow: { externalId: string | null; status: string } | null = null;
let sandboxQueryThrows = false;

/** What the fake daemon does when the route tries to attach. */
let daemonAttach: () => Promise<
  | { ok: true; body: ReadableStream<Uint8Array>; epoch: string | null }
  | { ok: false; reason: string; status: number | null }
>;
let attachCalls: Array<{ since: number | null; epoch: string | null }> = [];

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (sandboxQueryThrows) throw new Error('pool exhausted');
            return sandboxRow ? [sandboxRow] : [];
          },
        }),
      }),
    }),
  },
  hasDatabase: true,
}));

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => loadedProject,
  assertProjectCapability: async () => {},
  loadVisibleSession: async () => visibleSession,
}));

mock.module('../lib/session-runtime-transport', () => ({
  openRuntimeEventStream: async (
    _target: unknown,
    options: { since?: number | null; epoch?: string | null },
  ) => {
    attachCalls.push({ since: options.since ?? null, epoch: options.epoch ?? null });
    return daemonAttach();
  },
  parseSseFrames: realParseSseFrames,
}));

mock.module('../lib/session-runtime-projection-refresh', () => ({
  refreshRuntimeProjection: async () => ({ refreshed: false, reason: 'test' }),
  scheduleRuntimeProjectionRefresh: () => {},
}));

mock.module('../lib/session-runtime-projection', () => ({
  readRuntimeLeg: async () => ({ known: false, reason: 'no_projection' }),
}));

const controlEvents = await import('../lib/session-control-events');
const { publishControlEvent, CONTROL_EPOCH, __resetControlEventsForTests } = controlEvents;

/** The reconciler is replaced with a hand-driven one: this file is about the
 *  ROUTE, and a real reconciler would put a DB poll on a 5 s timer inside it. */
let reconcilerSnapshot: unknown[] = [];
mock.module('../lib/session-control-reconciler', () => ({
  acquireControlReconciler: () => ({
    ready: async () => {},
    snapshot: () => reconcilerSnapshot,
    poke: () => {},
    release: () => {},
  }),
  publishRuntimeStateFrame: () => null,
}));

const { projectsApp } = await import('../lib/app');
await import('./session-stream');

function buildApp() {
  const app = new Hono<{ Variables: { userId: string; authType: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function openStream(query = '', headers: Record<string, string> = {}) {
  return buildApp().request(
    `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/events${query}`,
    { headers },
  );
}

interface WireFrame {
  event: string | null;
  id: string | null;
  data: Record<string, unknown>;
}

/**
 * Read SSE frames off a live response until `want` of them have arrived or the
 * budget expires. Never waits for the stream to end — it never ends.
 */
async function readFrames(
  response: Response,
  want: number,
  budgetMs = 3_000,
): Promise<WireFrame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: WireFrame[] = [];
  let buffer = '';
  const deadline = Date.now() + budgetMs;
  try {
    while (frames.length < want && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event: string | null = null;
        let id: string | null = null;
        const data: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('data: ')) data.push(line.slice(6));
        }
        if (data.length) {
          frames.push({ event, id, data: JSON.parse(data.join('\n')) });
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function daemonStream(frames: string[], keepOpenMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (keepOpenMs > 0) setTimeout(() => controller.close(), keepOpenMs);
      else controller.close();
    },
  });
}

beforeEach(() => {
  __resetControlEventsForTests();
  attachCalls = [];
  reconcilerSnapshot = [];
  sandboxQueryThrows = false;
  loadedProject = { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID }, userId: USER_ID };
  visibleSession = { row: { sessionId: SESSION_ID }, grants: [], canManageProject: true };
  sandboxRow = { externalId: 'box-1', status: 'active' };
  daemonAttach = async () => ({ ok: false, reason: 'test_default', status: null });
});

afterEach(() => __resetControlEventsForTests());

describe('gates', () => {
  test('a non-uuid session id is rejected before anything is opened', async () => {
    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/sessions/not-a-uuid/events`,
    );
    expect(response.status).toBe(400);
  });

  test('an invisible session is 404, not an empty stream', async () => {
    visibleSession = null;
    const response = await openStream();
    expect(response.status).toBe(404);
  });

  test('a tombstoned session is 404', async () => {
    visibleSession = {
      row: { sessionId: SESSION_ID, metadata: { deletedAt: new Date().toISOString() } },
    };
    const response = await openStream();
    expect(response.status).toBe(404);
  });
});

describe('the stream opens, always', () => {
  test('200 + event-stream headers, never compressed, never buffered', async () => {
    const response = await openStream();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('x-kortix-control-epoch')).toBe(CONTROL_EPOCH);
    await response.body?.cancel();
  });

  test('hello names the control epoch and the cursors the client asked for', async () => {
    const response = await openStream('?since=41&epoch=ep_1&since_control=7&cepoch=' + CONTROL_EPOCH);
    const [hello] = await readFrames(response, 1);
    expect(hello!.event).toBe('kortix.stream.hello');
    expect(hello!.data).toMatchObject({
      type: 'kortix.stream.hello',
      channel: 'stream',
      session_id: SESSION_ID,
    });
    expect((hello!.data.runtime as Record<string, unknown>).requested_since).toBe(41);
    expect((hello!.data.runtime as Record<string, unknown>).requested_epoch).toBe('ep_1');
    expect((hello!.data.control as Record<string, unknown>).cepoch).toBe(CONTROL_EPOCH);
  });
});

describe('box down — the stream still serves', () => {
  test('no sandbox row: 200, control events keep flowing, runtime says down', async () => {
    sandboxRow = null;
    const response = await openStream();
    // The queue snapshot the reconciler would have taken, published live.
    setTimeout(() => publishControlEvent(SESSION_ID, 'kortix.control.queue', { prompts: [] }), 30);
    const frames = await readFrames(response, 3);

    const status = frames.find((frame) => frame.event === 'kortix.runtime.status');
    expect(status?.data).toMatchObject({ state: 'down', reason: 'no_sandbox' });

    const queue = frames.find((frame) => frame.event === 'kortix.control.queue');
    expect(queue?.data).toMatchObject({ channel: 'control', cseq: 1 });
    // Zero attach attempts: a stopped box must never be woken by a READ.
    expect(attachCalls).toHaveLength(0);
  });

  test('a stopped sandbox is never attached to, and the reason names the status', async () => {
    sandboxRow = { externalId: 'box-1', status: 'stopped' };
    const response = await openStream();
    const frames = await readFrames(response, 2);
    expect(
      frames.find((frame) => frame.event === 'kortix.runtime.status')?.data,
    ).toMatchObject({ state: 'down', reason: 'sandbox_stopped' });
    expect(attachCalls).toHaveLength(0);
  });

  test('an unreachable daemon reports the reason and does not fail the response', async () => {
    daemonAttach = async () => ({ ok: false, reason: 'daemon_503', status: 503 });
    const response = await openStream();
    const frames = await readFrames(response, 2);
    expect(response.status).toBe(200);
    expect(
      frames.find((frame) => frame.event === 'kortix.runtime.status')?.data,
    ).toMatchObject({ state: 'down', reason: 'daemon_503' });
  });

  test('a control-plane read failure degrades to a reason, not to a dead stream', async () => {
    sandboxQueryThrows = true;
    const response = await openStream();
    const frames = await readFrames(response, 2);
    expect(
      frames.find((frame) => frame.event === 'kortix.runtime.status')?.data,
    ).toMatchObject({ state: 'down', reason: 'control_plane_unavailable' });
  });
});

describe('runtime channel: forwarded verbatim, never renumbered', () => {
  test("the daemon's seq survives the hop, and the frame is tagged channel:runtime", async () => {
    daemonAttach = async () => ({
      ok: true,
      epoch: 'bmtaokkdb0piayh',
      body: daemonStream(
        [
          'event: kortix.hello\ndata: {"type":"kortix.hello","epoch":"bmtaokkdb0piayh","head_seq":2016,"first_seq":517,"since":null,"at":1}\n\n',
          'event: session.status\nid: 2016\ndata: {"seq":2016,"type":"session.status","at":2,"payload":{"sessionID":"ses_abc","status":{"type":"busy"}},"session":"ses_abc"}\n\n',
        ],
        500,
      ),
    });
    const response = await openStream();
    const frames = await readFrames(response, 4);

    const status = frames.find((frame) => frame.event === 'session.status');
    expect(status).toBeDefined();
    // THE property: 2016 in, 2016 out. Not 1, not a rebased number.
    expect(status!.data.seq).toBe(2016);
    expect(status!.data.channel).toBe('runtime');
    expect(status!.data.epoch).toBe('bmtaokkdb0piayh');
    // `payload` is OpenCode's `properties` verbatim — an existing reducer must
    // keep working without a translation layer.
    expect(status!.data.payload).toEqual({ sessionID: 'ses_abc', status: { type: 'busy' } });
    // No control cursor leaked onto a runtime frame.
    expect(status!.data.cseq).toBeUndefined();
  });

  test('a heartbeat from the daemon is forwarded, carrying no seq', async () => {
    daemonAttach = async () => ({
      ok: true,
      epoch: 'ep',
      body: daemonStream(
        ['event: kortix.heartbeat\ndata: {"type":"kortix.heartbeat","at":9,"head_seq":41}\n\n'],
        500,
      ),
    });
    const frames = await readFrames(await openStream(), 4);
    const heartbeat = frames.find((frame) => frame.event === 'kortix.heartbeat');
    expect(heartbeat?.data).toMatchObject({ channel: 'runtime', head_seq: 41 });
    expect(heartbeat?.data.seq).toBeUndefined();
    // A frame with no seq gets no `id:` — burning a cursor on it would make a
    // gap check lie.
    expect(heartbeat?.id).toBeNull();
  });

  test("a daemon resync is forwarded UNCHANGED and drops this stream's cursor", async () => {
    daemonAttach = async () => ({
      ok: true,
      epoch: 'ep',
      body: daemonStream(
        [
          'event: kortix.resync\ndata: {"type":"kortix.resync","reason":"gap-too-old","epoch":"ep","first_seq":517,"head_seq":2016,"requested_since":3,"recover":["GET /kortix/opencode/state"]}\n\n',
        ],
        500,
      ),
    });
    const frames = await readFrames(await openStream('?since=3&epoch=ep'), 4);
    const resync = frames.find((frame) => frame.event === 'kortix.resync');
    expect(resync?.data).toMatchObject({
      reason: 'gap-too-old',
      first_seq: 517,
      head_seq: 2016,
      recover: ['GET /kortix/opencode/state'],
    });
  });

  test('?since= and ?epoch= are handed to the daemon untouched', async () => {
    daemonAttach = async () => ({ ok: false, reason: 'stop', status: null });
    const response = await openStream('?since=1234&epoch=ep_x');
    await readFrames(response, 2);
    expect(attachCalls[0]).toEqual({ since: 1234, epoch: 'ep_x' });
  });
});

describe('the two cursors never mix', () => {
  test('a control frame carries cseq/cepoch and no seq; the id carries BOTH', async () => {
    daemonAttach = async () => ({
      ok: true,
      epoch: 'ep',
      body: daemonStream(
        ['event: message.updated\nid: 7\ndata: {"seq":7,"type":"message.updated","at":1,"payload":{}}\n\n'],
        800,
      ),
    });
    const response = await openStream();
    setTimeout(() => publishControlEvent(SESSION_ID, 'kortix.control.turn', { known: true }), 120);
    const frames = await readFrames(response, 5);

    const runtime = frames.find((frame) => frame.event === 'message.updated');
    const control = frames.find((frame) => frame.event === 'kortix.control.turn');
    expect(runtime?.data.seq).toBe(7);
    expect(control?.data.cseq).toBe(1);
    expect(control?.data.seq).toBeUndefined();
    expect(runtime?.data.cseq).toBeUndefined();

    // `epoch|seq|cepoch|cseq` — the control frame was written AFTER the runtime
    // frame, so its id holds both positions and a Last-Event-ID reconnect
    // restores both channels at once.
    expect(control?.id).toBe(`ep|7|${CONTROL_EPOCH}|1`);
  });

  test('Last-Event-ID restores both cursors when no query parameters are given', async () => {
    daemonAttach = async () => ({ ok: false, reason: 'stop', status: null });
    publishControlEvent(SESSION_ID, 'kortix.control.turn', { first: true });
    publishControlEvent(SESSION_ID, 'kortix.control.turn', { second: true });

    const response = await openStream('', {
      'last-event-id': `ep_prev|900|${CONTROL_EPOCH}|1`,
    });
    const frames = await readFrames(response, 3);

    // The runtime half went to the daemon.
    expect(attachCalls[0]).toEqual({ since: 900, epoch: 'ep_prev' });
    // The control half replayed exactly the one frame that was missed.
    const replayed = frames.filter((frame) => frame.event === 'kortix.control.turn');
    expect(replayed.map((frame) => frame.data.cseq)).toEqual([2]);
  });

  test('an explicit query parameter beats a stale Last-Event-ID', async () => {
    daemonAttach = async () => ({ ok: false, reason: 'stop', status: null });
    const response = await openStream('?since=5&epoch=ep_new', {
      'last-event-id': `ep_old|900|${CONTROL_EPOCH}|1`,
    });
    await readFrames(response, 2);
    expect(attachCalls[0]).toEqual({ since: 5, epoch: 'ep_new' });
  });
});

describe('control replay and resync', () => {
  test('a control cursor from a dead API process resyncs before any snapshot', async () => {
    publishControlEvent(SESSION_ID, 'kortix.control.turn', { known: true });
    const response = await openStream('?since_control=1&cepoch=capi_dead_process');
    const frames = await readFrames(response, 2);
    const resync = frames.find((frame) => frame.event === 'kortix.control.resync');
    expect(resync?.data).toMatchObject({
      type: 'kortix.control.resync',
      reason: 'epoch-changed',
      cepoch: CONTROL_EPOCH,
    });
  });

  test('the reconciler snapshot is written on open, so a client never waits a cycle', async () => {
    const snapshot = publishControlEvent(SESSION_ID, 'kortix.control.queue', {
      prompts: [{ id: 'p1' }],
    });
    reconcilerSnapshot = [snapshot];
    const frames = await readFrames(await openStream(), 2);
    const queue = frames.find((frame) => frame.event === 'kortix.control.queue');
    expect(queue?.data).toMatchObject({ cseq: snapshot.cseq, channel: 'control' });
  });

  test('a reconnect inside this epoch is NOT re-sent snapshots it already applied', async () => {
    // Found on the live stack: a reconnect at cseq=4 re-delivered cseq 1..4.
    // Idempotent, but it is four frames of work a caught-up client does not
    // need, on every reconnect.
    const turn = publishControlEvent(SESSION_ID, 'kortix.control.turn', { known: true });
    const queue = publishControlEvent(SESSION_ID, 'kortix.control.queue', { prompts: [] });
    reconcilerSnapshot = [turn, queue];
    const response = await openStream(
      `?since_control=${queue.cseq}&cepoch=${CONTROL_EPOCH}`,
    );
    const frames = await readFrames(response, 4, 600);
    expect(frames.filter((frame) => frame.data.channel === 'control')).toHaveLength(0);
    expect(frames[0]!.event).toBe('kortix.stream.hello');
  });

  test('but a RESYNC re-sends everything, because the cursor is void', async () => {
    const turn = publishControlEvent(SESSION_ID, 'kortix.control.turn', { known: true });
    reconcilerSnapshot = [turn];
    const response = await openStream('?since_control=1&cepoch=capi_dead_process');
    const frames = await readFrames(response, 3, 800);
    expect(frames.map((frame) => frame.event)).toContain('kortix.control.resync');
    expect(frames.map((frame) => frame.event)).toContain('kortix.control.turn');
  });

  test('a frame already replayed is not written twice', async () => {
    const snapshot = publishControlEvent(SESSION_ID, 'kortix.control.queue', { prompts: [] });
    reconcilerSnapshot = [snapshot];
    const frames = await readFrames(await openStream(), 4, 600);
    const queues = frames.filter((frame) => frame.event === 'kortix.control.queue');
    expect(queues).toHaveLength(1);
  });
});
