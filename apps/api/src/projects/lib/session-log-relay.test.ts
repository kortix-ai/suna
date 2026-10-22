/**
 * The old-daemon conversion of the session stream (P4.4): v1 transcript frames in, `log.*`
 * frames out, every other frame unchanged. Pure: the mirror read is the `readMirror` seam.
 */
import { describe, expect, test } from 'bun:test';
import {
  SESSION_LOG_EVENTS,
  V1_TRANSCRIPT_EVENTS,
  isV1TranscriptEvent,
  v1Seqs,
  type SessionLogEventType,
  type V1Row,
} from '@kortix/api-contract/session-log';
import { createV1LogConverter, dropV1Transcript, type RuntimeEnvelope, type V1Mirror } from './session-log-relay';
import recorded from './session-log-relay.fixture.json';

const SESSION = '55555555-5555-4555-8555-555555555555';
const ROOT = 'ses_root0001';
const CHILD = 'ses_child001';
const T0 = 1_791_700_000_000;

const user = (id: string, created: number, sessionID = ROOT) => ({
  id, sessionID, role: 'user', time: { created }, agent: 'kortix', model: { providerID: 'kortix', modelID: 'glm-5.3-flash' },
});
const reply = (id: string, created: number, parentID: string, extra: Record<string, unknown> = {}, sessionID = ROOT) => ({
  id, sessionID, role: 'assistant', time: { created }, parentID, modelID: 'glm-5.3-flash', providerID: 'kortix', mode: 'build',
  agent: 'kortix', path: { cwd: '/workspace', root: '/workspace' }, cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra,
});
const text = (id: string, messageID: string, value: string, sessionID = ROOT) => ({ id, sessionID, messageID, type: 'text', text: value });
const tool = (id: string, messageID: string, state: Record<string, unknown>, sessionID = ROOT) => ({
  id, sessionID, messageID, type: 'tool', callID: `call_${id}`, tool: 'bash', state,
});

let seq = 100;
/** A v1 daemon envelope, as `/kortix/runtime/events` sends it. */
const frame = (type: string, payload: Record<string, unknown>): RuntimeEnvelope => ({ seq: ++seq, type, at: T0 + seq, payload, session: ROOT });

/** Two stored messages of an earlier turn. */
const STORED: V1Row[] = [
  { runtime_session_id: ROOT, info: user('msg_a1', T0) as never, parts: [] },
  { runtime_session_id: ROOT, info: reply('msg_a2', T0 + 10, 'msg_a1', { time: { created: T0 + 10, completed: T0 + 20 }, finish: 'stop' }) as never, parts: [] },
];

function converter(mirror: V1Mirror = { root_id: ROOT, rows: STORED }) {
  const reads: number[] = [];
  const convert = createV1LogConverter({
    sessionId: SESSION,
    readMirror: async () => {
      reads.push(1);
      return structuredClone(mirror);
    },
  });
  return { convert, reads };
}

/** Every `log.*` frame validates against its payload schema. */
function expectValid(frames: RuntimeEnvelope[]) {
  for (const f of frames) {
    const schema = SESSION_LOG_EVENTS[f.type as SessionLogEventType];
    if (!schema) continue;
    const parsed = schema.safeParse(f.payload);
    expect(parsed.success, `${String(f.type)}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
  }
}

describe('the v1 transcript frames', () => {
  test('are exactly the five message.* frames; every other frame is not one', () => {
    expect([...V1_TRANSCRIPT_EVENTS]).toEqual([
      'message.updated', 'message.part.updated', 'message.part.delta', 'message.removed', 'message.part.removed',
    ]);
    for (const type of V1_TRANSCRIPT_EVENTS) expect(isV1TranscriptEvent(type)).toBe(true);
    for (const type of ['session.status', 'session.idle', 'session.error', 'session.updated', 'session.diff', 'permission.asked',
      'question.asked', 'todo.updated', 'kortix.turn', 'kortix.hello', 'log.message']) expect(isV1TranscriptEvent(type)).toBe(false);
  });

  test('a native v2 relay drops a stray transcript frame and passes every other frame as it is', () => {
    const status = frame('session.status', { sessionID: ROOT, status: { type: 'busy' } });
    expect(dropV1Transcript(status)).toEqual([status]);
    const put = frame('log.message', { rev: 1, message: {} });
    expect(dropV1Transcript(put)).toEqual([put]);
    expect(dropV1Transcript(frame('message.part.updated', { part: {} }))).toEqual([]);
  });
});

describe('the old-daemon conversion', () => {
  test('a turn: the v1 frames become valid log.* frames, block id = part id, deltas map one to one', async () => {
    const { convert } = converter();
    const out: RuntimeEnvelope[] = [];
    const push = async (f: RuntimeEnvelope) => out.push(...(await convert(f)));

    await push(frame('message.updated', { sessionID: ROOT, info: user('msg_b1', T0 + 100) }));
    await push(frame('message.part.updated', { sessionID: ROOT, part: text('prt_b1a', 'msg_b1', 'run ls') }));
    await push(frame('message.updated', { sessionID: ROOT, info: reply('msg_b2', T0 + 110, 'msg_b1') }));
    await push(frame('message.part.updated', { sessionID: ROOT, part: tool('prt_b2a', 'msg_b2', { status: 'pending', input: {}, raw: '' }) }));
    await push(frame('message.part.updated', { sessionID: ROOT, part: tool('prt_b2a', 'msg_b2', { status: 'running', input: { command: 'ls' }, time: { start: T0 + 120 } }) }));
    await push(frame('message.part.updated', { sessionID: ROOT, part: tool('prt_b2a', 'msg_b2', { status: 'completed', input: { command: 'ls' }, output: 'a.txt', title: 'ls', metadata: {}, time: { start: T0 + 120, end: T0 + 130 } }) }));
    await push(frame('message.part.updated', { sessionID: ROOT, part: text('prt_b2b', 'msg_b2', '') }));
    await push(frame('message.part.delta', { sessionID: ROOT, messageID: 'msg_b2', partID: 'prt_b2b', field: 'text', delta: 'One ' }));
    await push(frame('message.part.delta', { sessionID: ROOT, messageID: 'msg_b2', partID: 'prt_b2b', field: 'text', delta: 'file.' }));
    await push(frame('message.updated', { sessionID: ROOT, info: reply('msg_b2', T0 + 110, 'msg_b1', { time: { created: T0 + 110, completed: T0 + 140 }, finish: 'stop' }) }));

    expectValid(out);
    // No v1 transcript frame survives.
    expect(out.some((f) => isV1TranscriptEvent(String(f.type)))).toBe(false);
    expect(out.map((f) => f.type)).toEqual([
      'log.message', 'log.message', 'log.message', 'log.message', 'log.message', 'log.message', 'log.message',
      'log.block.delta', 'log.block.delta', 'log.message',
    ]);
    const payloads = out.map((f) => f.payload as any);
    // The seq fromV1 gives them after the two stored messages: 3 and 4.
    expect(payloads[0].message).toMatchObject({ message_id: 'msg_b1', thread_id: ROOT, seq: 3, role: 'user', status: 'complete' });
    expect(payloads[1].message.blocks).toEqual([{ type: 'text', id: 'prt_b1a', text: 'run ls' }]);
    expect(payloads[2].message).toMatchObject({ message_id: 'msg_b2', seq: 4, status: 'streaming', reply_to: 'msg_b1', completed_at: null, finish: null, blocks: [] });
    // The open call stays open: no closure result while the turn runs.
    expect(payloads[3].message.blocks[0]).toMatchObject({ type: 'tool_call', id: 'prt_b2a', status: 'pending' });
    expect(payloads[3].message.blocks[0].result).toBeUndefined();
    expect(payloads[4].message.blocks[0]).toMatchObject({ status: 'running', input: { command: 'ls' } });
    expect(payloads[5].message.blocks[0]).toMatchObject({ status: 'complete', result: { content: [{ type: 'text', text: 'a.txt' }], is_error: false } });
    expect(payloads[6].message.blocks[1]).toEqual({ type: 'text', id: 'prt_b2b', text: '' });
    expect(payloads[7]).toEqual({ thread_id: ROOT, message_id: 'msg_b2', block_id: 'prt_b2b', delta: 'One ' });
    // The final put holds the streamed text and the completion.
    expect(payloads[9].message).toMatchObject({ status: 'complete', finish: 'stop' });
    expect(payloads[9].message.blocks[1]).toEqual({ type: 'text', id: 'prt_b2b', text: 'One file.' });
    // Revs rise within the stream, microseconds.
    const revs = payloads.filter((p) => typeof p.rev === 'number').map((p) => p.rev as number);
    for (let i = 1; i < revs.length; i++) expect(revs[i]!).toBeGreaterThan(revs[i - 1]!);
    expect(revs[0]!).toBeGreaterThan(Date.now() * 1000 - 60_000_000);
  });

  test('a converted frame keeps the v1 envelope: seq, at and session', async () => {
    const { convert } = converter();
    const source = frame('message.updated', { sessionID: ROOT, info: user('msg_c1', T0 + 200) });
    const [put] = await convert(source);
    expect(put).toMatchObject({ seq: source.seq, at: source.at, session: ROOT, type: 'log.message' });
  });

  test('message.removed is a tombstone; message.part.removed is a put without the block', async () => {
    const { convert } = converter();
    await convert(frame('message.updated', { sessionID: ROOT, info: user('msg_d1', T0 + 300) }));
    await convert(frame('message.part.updated', { sessionID: ROOT, part: text('prt_d1a', 'msg_d1', 'a') }));
    await convert(frame('message.part.updated', { sessionID: ROOT, part: text('prt_d1b', 'msg_d1', 'b') }));
    const removedPart = await convert(frame('message.part.removed', { sessionID: ROOT, messageID: 'msg_d1', partID: 'prt_d1a' }));
    expectValid(removedPart);
    expect((removedPart[0]!.payload as any).message.blocks.map((b: { id: string }) => b.id)).toEqual(['prt_d1b']);
    const removed = await convert(frame('message.removed', { sessionID: ROOT, messageID: 'msg_d1' }));
    expectValid(removed);
    expect(removed[0]).toMatchObject({ type: 'log.message', payload: { message_id: 'msg_d1' } });
    expect((removed[0]!.payload as any).message).toBeUndefined();
    // A removed message does not take a seq: the next one gets 3, as fromV1 of the mirror without it.
    const [next] = await convert(frame('message.updated', { sessionID: ROOT, info: user('msg_d2', T0 + 400) }));
    expect((next!.payload as any).message.seq).toBe(3);
  });

  test('the root session update is passed through and followed by log.state; a child update is passed alone', async () => {
    const { convert } = converter();
    const root = frame('session.updated', { info: { id: ROOT, title: 'List files', time: { created: T0, updated: T0 + 1 } } });
    const out = await convert(root);
    expect(out[0]).toBe(root);
    expect(out[1]).toMatchObject({ seq: root.seq, type: 'log.state', payload: { generation: 0, session: { title: 'List files' } } });
    expectValid(out);
    const child = frame('session.updated', { info: { id: CHILD, parentID: ROOT, title: 'sub', time: { created: T0 } } });
    expect(await convert(child)).toEqual([child]);
  });

  test('every non-transcript frame passes through unchanged', async () => {
    const { convert } = converter();
    for (const f of [
      frame('session.status', { sessionID: ROOT, status: { type: 'busy' } }),
      frame('session.idle', { sessionID: ROOT }),
      frame('session.error', { sessionID: ROOT, error: { name: 'UnknownError', data: { message: 'x' } } }),
      frame('session.diff', { sessionID: ROOT, diff: [] }),
      frame('permission.asked', { id: 'per_1', sessionID: ROOT }),
      frame('question.asked', { id: 'que_1', sessionID: ROOT }),
      frame('todo.updated', { sessionID: ROOT, todos: [] }),
      frame('kortix.turn', { runtime_session_id: ROOT }),
      { type: 'kortix.heartbeat', at: 1, head_seq: 5 },
    ]) expect(await convert(f)).toEqual([f]);
  });

  test('a delta of another field, or of a part never announced, is handled without a put', async () => {
    const { convert } = converter();
    expect(await convert(frame('message.part.delta', { sessionID: ROOT, messageID: 'm', partID: 'p', field: 'metadata', delta: 'x' }))).toEqual([]);
    // The client drops a delta for a block it does not hold; the relay still sends it.
    const out = await convert(frame('message.part.delta', { sessionID: ROOT, messageID: 'm', partID: 'p', field: 'text', delta: 'x' }));
    expect(out.map((f) => f.type)).toEqual(['log.block.delta']);
  });
});

describe('the converted seq is the seq fromV1 of the mirror gives', () => {
  test('a child thread and the in-flight order: equal to v1Seqs of the captured mirror', async () => {
    const { convert, reads } = converter();
    const frames = [
      frame('message.updated', { sessionID: ROOT, info: user('msg_e1', T0 + 500) }),
      frame('message.updated', { sessionID: ROOT, info: reply('msg_e2', T0 + 510, 'msg_e1') }),
      frame('message.part.updated', { sessionID: ROOT, part: tool('prt_e2a', 'msg_e2', { status: 'running', input: { prompt: 'x' }, metadata: { sessionId: CHILD }, time: { start: T0 + 511 } }) }),
      frame('message.updated', { sessionID: CHILD, info: user('msg_f1', T0 + 520, CHILD) }),
      frame('message.updated', { sessionID: CHILD, info: reply('msg_f2', T0 + 530, 'msg_f1', {}, CHILD) }),
      frame('message.part.updated', { sessionID: CHILD, part: text('prt_f2a', 'msg_f2', 'done', CHILD) }),
    ];
    const seen = new Map<string, number>();
    for (const f of frames) {
      for (const out of await convert(f)) {
        const m = (out.payload as any).message;
        if (m) {
          if (seen.has(m.message_id)) expect(m.seq).toBe(seen.get(m.message_id)!);
          seen.set(m.message_id, m.seq);
        }
      }
    }
    // One mirror read for the whole turn: no kortix.turn came.
    expect(reads).toHaveLength(1);
    // The capture writes the turn's rows; fromV1 of that mirror numbers them the same.
    const captured: V1Row[] = [
      ...STORED,
      { runtime_session_id: ROOT, info: user('msg_e1', T0 + 500) as never, parts: [] },
      { runtime_session_id: ROOT, info: reply('msg_e2', T0 + 510, 'msg_e1') as never, parts: [tool('prt_e2a', 'msg_e2', { status: 'completed', input: { prompt: 'x' }, output: 'ok', metadata: { sessionId: CHILD }, time: { start: T0 + 511, end: T0 + 540 } }) as never] },
      { runtime_session_id: CHILD, info: user('msg_f1', T0 + 520, CHILD) as never, parts: [] },
      { runtime_session_id: CHILD, info: reply('msg_f2', T0 + 530, 'msg_f1', {}, CHILD) as never, parts: [] },
    ];
    const expected = v1Seqs({ session_id: SESSION, root_id: ROOT, rows: captured });
    for (const [id, s] of seen) expect(s).toBe(expected.get(id)!);
    expect(Object.fromEntries(seen)).toEqual({ msg_e1: 3, msg_e2: 4, msg_f1: 1, msg_f2: 2 });
  });

  test('a turn end re-reads the mirror at the next new message', async () => {
    const { convert, reads } = converter();
    await convert(frame('message.updated', { sessionID: ROOT, info: user('msg_g1', T0 + 600) }));
    await convert(frame('message.updated', { sessionID: ROOT, info: user('msg_g1', T0 + 600) }));
    expect(reads).toHaveLength(1);
    await convert(frame('kortix.turn', { runtime_session_id: ROOT }));
    await convert(frame('message.updated', { sessionID: ROOT, info: user('msg_g2', T0 + 700) }));
    expect(reads).toHaveLength(2);
  });

  test('a mirror read that fails numbers from the in-flight rows alone', async () => {
    const convert = createV1LogConverter({ sessionId: SESSION, readMirror: async () => { throw new Error('pool exhausted'); } });
    const [put] = await convert(frame('message.updated', { sessionID: ROOT, info: user('msg_h1', T0 + 800) }));
    expect((put!.payload as any).message.seq).toBe(1);
  });
});

/**
 * `session-log-relay.fixture.json`, recorded on a worktree stack (P4.4 rule-6 run, synthetic
 * project): the daemon's v1 envelopes of a 3-turn session with a bash call per turn (turn 1 on
 * the current daemon, turns 2 and 3 on the pre-P4.3 daemon build), and the session's v1 mirror
 * rows after the third turn's capture.
 */

describe('a recorded 3-turn session', () => {
  test('every put carries the seq fromV1 of the mirror gives, and every log.* frame is valid', async () => {
    const fixture = recorded as unknown as { frames: RuntimeEnvelope[]; mirror: V1Mirror };
    const mirror = fixture.mirror;
    // The capture runs at each turn end: the mirror holds the turns that ended before the read.
    const captured = new Set<string>();
    const seen = new Set<string>();
    const convert = createV1LogConverter({
      sessionId: SESSION,
      readMirror: async () => ({ root_id: mirror.root_id, rows: mirror.rows.filter((r) => captured.has(String(r.info.id))) }),
    });
    const out: RuntimeEnvelope[] = [];
    for (const f of fixture.frames) {
      const id = (f.payload as any)?.info?.id;
      if (f.type === 'message.updated' && typeof id === 'string') seen.add(id);
      out.push(...(await convert(f)));
      if (f.type === 'kortix.turn') for (const s of seen) captured.add(s);
    }
    expectValid(out);
    expect(out.some((f) => isV1TranscriptEvent(String(f.type)))).toBe(false);
    const expected = v1Seqs({ session_id: SESSION, root_id: mirror.root_id, rows: mirror.rows });
    const puts = out.filter((f) => f.type === 'log.message' && (f.payload as any).message).map((f) => (f.payload as any).message);
    expect(new Set(puts.map((m) => m.message_id))).toEqual(new Set(expected.keys()));
    for (const m of puts) expect(m.seq).toBe(expected.get(m.message_id)!);
    expect([...expected.values()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Every v1 text delta became one log.block.delta on the same part id.
    const deltas = fixture.frames.filter((f) => f.type === 'message.part.delta' && (f.payload as any).field === 'text');
    expect(out.filter((f) => f.type === 'log.block.delta').map((f) => (f.payload as any).block_id)).toEqual(deltas.map((f) => (f.payload as any).partID));
    // The turn end leaves every message complete.
    const last = new Map(puts.map((m) => [m.message_id, m]));
    for (const m of last.values()) expect(m.status).toBe('complete');
  });
});
