import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fromV1,
  toV1,
  upcast,
  SessionLogMessageSchema,
  SessionLogSchema,
  type SessionLog,
  type SessionLogMessage,
  type ToolCallBlock,
  type V1Row,
  type V1Transcript,
} from '../session-log';

// Synthetic v1 mirrors. Every id and value is invented. The main fixture covers every part
// variant `transcript.ts` defines, plus the stored shapes the converter must survive.

const T0 = 1_790_000_000_000;
const tokens = (input = 10, output = 5) => ({ total: input + output, input, output, reasoning: 1, cache: { read: 2, write: 3 } });
const model = { providerID: 'prov', modelID: 'model-a' };
const base = (sid: string, mid: string, id: string) => ({ id, sessionID: sid, messageID: mid });

function user(sid: string, id: string, at: number, parts: (mid: string) => unknown[], extra: Record<string, unknown> = {}): V1Row {
  return { runtime_session_id: sid, info: { id, sessionID: sid, role: 'user', time: { created: at }, agent: 'build', model, ...extra } as never, parts: parts(id) as never };
}
function assistant(sid: string, id: string, at: number, parentID: string, parts: (mid: string) => unknown[], extra: Record<string, unknown> = {}): V1Row {
  return {
    runtime_session_id: sid,
    info: {
      id, sessionID: sid, role: 'assistant', time: { created: at, completed: at + 500 }, parentID,
      modelID: 'model-a', providerID: 'prov', mode: 'build', agent: 'build', path: { cwd: '/w', root: '/w' },
      cost: 0.25, tokens: tokens(), finish: 'stop', ...extra,
    } as never,
    parts: parts(id) as never,
  };
}
const text = (sid: string, mid: string, id: string, value: string, extra: Record<string, unknown> = {}) => ({ ...base(sid, mid, id), type: 'text', text: value, ...extra });
const tool = (sid: string, mid: string, id: string, name: string, state: Record<string, unknown>) => ({ ...base(sid, mid, id), type: 'tool', callID: `call_${id}`, tool: name, state });
const stepStart = (sid: string, mid: string, id: string) => ({ ...base(sid, mid, id), type: 'step-start', snapshot: 'snap0' });
const stepFinish = (sid: string, mid: string, id: string) => ({ ...base(sid, mid, id), type: 'step-finish', reason: 'stop', snapshot: 'snap1', cost: 0.25, tokens: tokens() });

const ROOT = 'ses_root0000000000000000001';
const CHILD = 'ses_child000000000000000001';
const GRAND = 'ses_grand000000000000000001';
const OLD = 'ses_old00000000000000000001';
const OLD_CHILD = 'ses_oldchild0000000000000001';

/** Every part variant, stripped and open tool calls, compactions, a child, a grandchild and a two-root mirror. */
function mainFixture(): V1Transcript {
  const R = ROOT;
  const rows: V1Row[] = [
    // The old root, kept after a re-pin: it predates the current root and spawned a child.
    user(OLD, 'msg_o01', T0, (m) => [text(OLD, m, 'prt_o01a', 'old question')]),
    assistant(OLD, 'msg_o02', T0 + 1_000, 'msg_o01', (m) => [
      tool(OLD, m, 'prt_o02a', 'bash', { status: 'completed', title: 'ls', metadata: { exit: 0 }, time: { start: T0 + 1_100, end: T0 + 1_200 } }),
      tool(OLD, m, 'prt_o02b', 'task', { status: 'completed', input: { description: 'old sub', subagent_type: 'general' }, output: 'done', title: 'old sub', metadata: { sessionId: OLD_CHILD }, time: { start: T0 + 1_300, end: T0 + 1_900 } }),
    ]),
    user(OLD_CHILD, 'msg_oc01', T0 + 1_400, (m) => [text(OLD_CHILD, m, 'prt_oc01a', 'old sub prompt')]),
    assistant(OLD_CHILD, 'msg_oc02', T0 + 1_500, 'msg_oc01', (m) => [text(OLD_CHILD, m, 'prt_oc02a', 'old sub answer')]),

    // Current root: a user turn with every user-side part.
    user(R, 'msg_r01', T0 + 10_000, (m) => [
      text(R, m, 'prt_r01a', 'look at this', { time: { start: T0 + 10_000, end: T0 + 10_001 } }),
      { ...base(R, m, 'prt_r01b'), type: 'file', mime: 'image/png', filename: 'shot.png', url: 'kortix-attachment://p/s/att1', source: { type: 'file', path: '/w/shot.png', text: { value: '@shot.png', start: 0, end: 9 } } },
      { ...base(R, m, 'prt_r01c'), type: 'file', mime: 'text/plain', filename: 'notes.txt' },
      text(R, m, 'prt_r01d', 'Called the Read tool with notes.txt', { synthetic: true }),
      text(R, m, 'prt_r01e', 'ignored by the model', { ignored: true }),
      { ...base(R, m, 'prt_r01f'), type: 'agent', name: 'build', source: { value: '@build', start: 0, end: 6 } },
      { ...base(R, m, 'prt_r01g'), type: 'subtask', prompt: 'p', description: 'd', agent: 'general', model: { providerID: 'prov', modelID: 'model-b' }, command: 'review' },
    ], { model: { ...model, variant: 'high' }, system: 'extra system', tools: { bash: true }, summary: { title: 'T', diffs: [] } }),

    // A completed assistant turn with every assistant-side part.
    assistant(R, 'msg_r02', T0 + 11_000, 'msg_r01', (m) => [
      stepStart(R, m, 'prt_r02a'),
      { ...base(R, m, 'prt_r02b'), type: 'reasoning', text: 'thinking', metadata: { anthropic: { signature: 'sig' } }, time: { start: T0 + 11_001, end: T0 + 11_002 } },
      text(R, m, 'prt_r02c', 'Here is the answer.', { time: { start: T0 + 11_003, end: T0 + 11_004 }, metadata: { k: 1 } }),
      tool(R, m, 'prt_r02d', 'bash', { status: 'completed', input: { command: 'ls' }, output: 'a\nb', title: 'ls', metadata: { exit: 0, output: 'a\nb' }, time: { start: T0 + 11_010, end: T0 + 11_020 } }),
      tool(R, m, 'prt_r02e', 'read', {
        status: 'completed', input: { filePath: '/w/shot.png' }, output: 'Image read', title: 'shot.png', metadata: {},
        time: { start: T0 + 11_030, end: T0 + 11_040, compacted: T0 + 30_000 },
        attachments: [{ ...base(R, m, 'prt_r02e_att'), type: 'file', mime: 'image/png', url: 'kortix-attachment://p/s/att2' }],
      }),
      tool(R, m, 'prt_r02f', 'edit', { status: 'error', input: { filePath: '/w/x' }, error: 'no such file', time: { start: T0 + 11_050, end: T0 + 11_060 } }),
      tool(R, m, 'prt_r02g', 'task', { status: 'completed', input: { description: 'sub', prompt: 'go', subagent_type: 'general' }, output: 'sub done', title: 'sub', metadata: { sessionId: CHILD, model }, time: { start: T0 + 11_070, end: T0 + 13_000 } }),
      // Legacy stripped rows: the old mirror kept title/metadata/time only.
      tool(R, m, 'prt_r02h', 'bash', { status: 'completed', title: 'pwd', metadata: { exit: 0 }, time: { start: T0 + 13_010, end: T0 + 13_020 } }),
      tool(R, m, 'prt_r02i', 'linear_create_issue', { status: 'error', title: '', time: { start: T0 + 13_030, end: T0 + 13_040 } }),
      { ...base(R, m, 'prt_r02j'), type: 'patch', hash: 'abc123', files: ['/w/x'] },
      { ...base(R, m, 'prt_r02k'), type: 'snapshot', snapshot: 'snap2' },
      { ...base(R, m, 'prt_r02l'), type: 'retry', attempt: 1, error: { name: 'APIError', data: { message: 'overloaded', isRetryable: true } }, time: { created: T0 + 11_005 } },
      stepFinish(R, m, 'prt_r02m'),
    ], { finish: 'tool-calls', variant: 'high' }),

    // Aborted with content: stays in context; its open calls are closed.
    assistant(R, 'msg_r03', T0 + 14_000, 'msg_r01', (m) => [
      text(R, m, 'prt_r03a', 'partial'),
      tool(R, m, 'prt_r03b', 'bash', { status: 'running', input: { command: 'sleep 9' }, title: 'sleep 9', metadata: {}, time: { start: T0 + 14_010 } }),
      tool(R, m, 'prt_r03c', 'grep', { status: 'pending', input: {}, raw: '{"pattern":' }),
    ], { error: { name: 'MessageAbortedError', data: { message: 'Aborted' }, code: 'aborted' }, finish: undefined, time: { created: T0 + 14_000 } }),

    // A failed attempt: out of context.
    assistant(R, 'msg_r04', T0 + 15_000, 'msg_r01', (m) => [stepStart(R, m, 'prt_r04a')], {
      error: { name: 'APIError', data: { message: 'rate limited', statusCode: 429, isRetryable: true }, code: 'rate_limit' }, finish: undefined, time: { created: T0 + 15_000 },
    }),

    // Never completed (the box died): at rest, so interrupted, and its pending call is closed.
    assistant(R, 'msg_r05', T0 + 16_000, 'msg_r01', (m) => [tool(R, m, 'prt_r05a', 'webfetch', { status: 'pending', input: { url: 'https://example.com' }, raw: '' })], {
      finish: undefined, time: { created: T0 + 16_000 },
    }),

    // Compaction with a cut point and a summary message.
    user(R, 'msg_r06', T0 + 20_000, (m) => [{ ...base(R, m, 'prt_r06a'), type: 'compaction', auto: true, tail_start_id: 'msg_r05' }]),
    assistant(R, 'msg_r07', T0 + 20_001, 'msg_r06', (m) => [stepStart(R, m, 'prt_r07a'), text(R, m, 'prt_r07b', 'Summary part one. '), text(R, m, 'prt_r07c', 'Part two.'), stepFinish(R, m, 'prt_r07d')], {
      summary: true, mode: 'compaction', agent: 'compaction',
    }),
    // Compaction without a cut point (counted), on overflow.
    user(R, 'msg_r08', T0 + 21_000, (m) => [{ ...base(R, m, 'prt_r08a'), type: 'compaction', auto: true, overflow: true }]),
    assistant(R, 'msg_r09', T0 + 21_001, 'msg_r08', (m) => [text(R, m, 'prt_r09a', 'Second summary.')], { summary: true, mode: 'compaction', agent: 'compaction' }),
    // A manual compaction whose summary never arrived.
    user(R, 'msg_r10', T0 + 22_000, (m) => [{ ...base(R, m, 'prt_r10a'), type: 'compaction', auto: false }]),

    // A message that repeats a part id, an unknown part type, a part that is not an object, and a missing id.
    assistant(R, 'msg_r11', T0 + 23_000, 'msg_r10', (m) => [
      text(R, m, 'prt_dup', 'first'),
      text(R, m, 'prt_dup', 'second'),
      text(R, m, 'prt_dup#2', 'third'),
      { ...base(R, m, 'prt_r11d'), type: 'mystery', payload: { a: [1, null] } },
      'not a part',
      { sessionID: R, messageID: m, type: 'text', text: 'no id' },
    ], { finish: 'content-filter', extra_info_field: { nested: true } }),

    // A row whose info.sessionID differs from the runtime session it was captured under.
    user(R, 'msg_r12', T0 + 24_000, (m) => [text(R, m, 'prt_r12a', 'mismatch')], { sessionID: 'ses_other' }),
    // Clock skew: the summary row sorts before its compaction marker.
    user(R, 'msg_r14', T0 + 25_000, (m) => [{ ...base(R, m, 'prt_r14a'), type: 'compaction', auto: true, tail_start_id: 'msg_r12' }]),
    assistant(R, 'msg_r13', T0 + 24_999, 'msg_r14', (m) => [text(R, m, 'prt_r13a', 'Skewed summary.')], { summary: true, mode: 'compaction', agent: 'compaction' }),

    // The child, spawned by msg_r02's task call, and its own child (named only in the call's error text).
    user(CHILD, 'msg_c01', T0 + 11_080, (m) => [text(CHILD, m, 'prt_c01a', 'go')], { agent: 'general' }),
    assistant(CHILD, 'msg_c02', T0 + 11_090, 'msg_c01', (m) => [
      tool(CHILD, m, 'prt_c02a', 'task', { status: 'error', input: { description: 'deeper', subagent_type: 'general' }, error: `failed. task_id: ${GRAND}`, time: { start: T0 + 11_100, end: T0 + 11_200 } }),
      text(CHILD, m, 'prt_c02b', 'sub done'),
    ], { agent: 'general', mode: 'general' }),
    user(GRAND, 'msg_g01', T0 + 11_110, (m) => [text(GRAND, m, 'prt_g01a', 'deeper')], { agent: 'general' }),
    assistant(GRAND, 'msg_g02', T0 + 11_120, 'msg_g01', (m) => [text(GRAND, m, 'prt_g02a', 'deep answer')]),
  ];
  return { session_id: 'sess-synthetic-1', root_id: ROOT, rows };
}

/** pi's v1 rows: callID equals the part id, compaction part ids end in -p0, a summary text part, no file parts. */
function piFixture(): V1Transcript {
  const S = 'ses_pi00000000000000000001';
  const rows: V1Row[] = [
    user(S, 'msg_p01', T0, (m) => [text(S, m, `${m}-p0`, 'hello pi')]),
    assistant(S, 'msg_p02', T0 + 100, 'msg_p01', (m) => [
      { ...text(S, m, `${m}-p0`, 'reading') },
      { ...base(S, m, `${m}-p1`), type: 'tool', callID: `${m}-p1`, tool: 'read', state: { status: 'completed', input: { path: 'a' }, output: 'x', title: 'a', metadata: {}, time: { start: T0 + 110, end: T0 + 120 } } },
    ]),
    user(S, 'msg_p03', T0 + 200, (m) => [{ ...base(S, m, `${m}-p0`), type: 'compaction', auto: true }]),
    assistant(S, 'msg_p04', T0 + 201, 'msg_p03', (m) => [text(S, m, `${m}-p0`, 'pi summary')], { summary: true }),
  ];
  return { session_id: 'sess-synthetic-pi', root_id: S, rows };
}

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const key = (r: V1Row) => canon(r);
const byId = (rows: V1Row[]) => [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
/** Strict equality on parsed JSON, rows in a fixed order: no field dropped, no key-order dependence. */
function expectExact(x: V1Transcript, back: V1Transcript) {
  const a = json(x);
  const b = json(back);
  expect(b.rows.length).toBe(a.rows.length);
  expect({ ...b, rows: byId(b.rows) }).toStrictEqual({ ...a, rows: byId(a.rows) });
}
const roundTrip = (x: V1Transcript, opts?: Parameters<typeof fromV1>[1]) => toV1(json(fromV1(json(x), opts)));

const messages = (log: SessionLog) => log.threads.flatMap((t) => t.messages);
const message = (log: SessionLog, id: string) => messages(log).find((m) => m.message_id === id)!;
const block = (m: SessionLogMessage, id: string) => m.blocks.find((b) => b.id === id)!;

const FIXTURES: Array<[string, () => V1Transcript, Parameters<typeof fromV1>[1]?]> = [
  ['main (every part variant, two roots, child + grandchild)', mainFixture],
  ['main as pi', mainFixture, { harness: 'pi' }],
  ['main with resolved attachments', mainFixture, { resolveAttachment: (p) => (p.url ? { ref: `blob:${p.id}`, bytes: 42 } : null) }],
  ['pi', piFixture, { harness: 'pi' }],
  ['empty mirror without a root', () => ({ session_id: 'sess-empty', root_id: null, rows: [] })],
  ['mirror without a root id', () => ({ ...piFixture(), root_id: null })],
  ['rows without a runtime session id', () => ({ ...piFixture(), rows: piFixture().rows.map((r) => ({ ...r, runtime_session_id: null })) })],
];

describe('fromV1 / toV1 round trip', () => {
  for (const [name, make, opts] of FIXTURES) {
    test(`toV1(fromV1(x)) deep-equals x: ${name}`, () => {
      expectExact(make(), roundTrip(make(), opts));
    });
    test(`fromV1 output validates with SessionLogSchema: ${name}`, () => {
      const log = json(fromV1(make(), opts));
      expect(upcast(log)).toBe(log);
    });
  }

  test('the main fixture holds every v1 part type', () => {
    const types = new Set(mainFixture().rows.flatMap((r) => (r.parts as unknown[]).map((p) => (p as { type?: string })?.type)));
    for (const t of ['text', 'subtask', 'reasoning', 'file', 'tool', 'step-start', 'step-finish', 'snapshot', 'patch', 'agent', 'retry', 'compaction']) expect(types.has(t)).toBe(true);
  });

  test('row order does not change the result', () => {
    const x = mainFixture();
    const shuffled = { ...x, rows: [...x.rows].reverse() };
    expect(json(fromV1(shuffled))).toStrictEqual(json(fromV1(x)));
  });

  test('exact and valid for 300 seeded perturbations of the stored jsonb (info, parts): deleted keys, swapped types, added keys', () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n);
    const values = [null, 0, -1.5, '', 'x', true, [], [1, 'a'], {}, { k: { n: null } }, T0, CHILD];
    const nodes = (v: unknown, out: object[] = []) => {
      if (v && typeof v === 'object') {
        out.push(v);
        for (const x of Object.values(v)) nodes(x, out);
      }
      return out;
    };
    for (let i = 0; i < 300; i++) {
      const x = json(mainFixture());
      for (let k = 0; k < 1 + rand(4); k++) {
        const row = x.rows[rand(x.rows.length)] as unknown as Record<string, unknown>;
        // A row's info and parts are NOT NULL jsonb columns: each may hold any JSON value.
        const all = [row, ...nodes(row.info), ...nodes(row.parts)];
        const node = all[rand(all.length)] as Record<string, unknown>;
        const keys = node === row ? ['info', 'parts'] : Object.keys(node);
        const key = keys.length && (node === row || rand(3)) ? keys[rand(keys.length)] : `added_${k}`;
        if (node !== row && !Array.isArray(node) && rand(4) === 0) delete node[key];
        else node[key] = values[rand(values.length)];
      }
      expectExact(x, roundTrip(x));
      expect(SessionLogSchema.safeParse(json(fromV1(x))).success).toBe(true);
    }
  });

  test('fromV1 does not mutate its input', () => {
    const x = mainFixture();
    const before = json(x);
    fromV1(x);
    expect(json(x)).toStrictEqual(before);
  });
});

describe('fromV1 mapping', () => {
  const log = fromV1(mainFixture());

  test('session: producer, grade and counts', () => {
    expect(log.session_id).toBe('sess-synthetic-1');
    expect(log.restore_grade).toBe('partial');
    // tool_input: prt_r02h, prt_r02i (in context). msg_o02's stripped call is superseded, out of context.
    // cut_point: msg_r08. attachment: prt_r01b and the read call's attachment (no resolver).
    expect(log.grade_counts).toEqual({ tool_input: 2, cut_point: 1, attachment: 2 });
    for (const m of messages(log)) expect(m.producer.harness).toBe('kortix-v1-import');
    expect(log.harness.current).toBe('opencode');
    expect(log.selection).toEqual({ agent: 'build', model: { provider: 'prov', model: 'model-a' } });
  });

  test('a clean session is converted, with zero counts', () => {
    const clean = fromV1({ session_id: 's', root_id: ROOT, rows: [user(ROOT, 'msg_1', T0, (m) => [text(ROOT, m, 'prt_1', 'hi')])] });
    expect(clean.restore_grade).toBe('converted');
    expect(clean.grade_counts).toEqual({ tool_input: 0, cut_point: 0, attachment: 0 });
  });

  test('threads: the root, the child and the grandchild; the old root is merged into the root as superseded', () => {
    expect(log.threads.map((t) => [t.thread_id, t.parent_thread_id, t.spawned_by])).toEqual([
      [ROOT, null, null],
      [OLD_CHILD, ROOT, { message_id: 'msg_o02', call_id: 'call_prt_o02b' }],
      [CHILD, ROOT, { message_id: 'msg_r02', call_id: 'call_prt_r02g' }],
      [GRAND, CHILD, { message_id: 'msg_c02', call_id: 'call_prt_c02a' }],
    ]);
    const root = log.threads[0];
    expect(root.messages.slice(0, 2).map((m) => [m.message_id, m.in_context, m.hidden_reason])).toEqual([
      ['msg_o01', false, 'superseded'],
      ['msg_o02', false, 'superseded'],
    ]);
    expect(root.messages.map((m) => m.seq)).toEqual(root.messages.map((_, i) => i + 1));
    expect(root.messages.some((m) => m.message_id === 'msg_r07')).toBe(false); // folded into the compaction message
  });

  test('block ids are the v1 part ids; a repeat is deduplicated as <id>#<n>', () => {
    const m02 = message(log, 'msg_r02');
    expect(m02.blocks.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'].map((s) => `prt_r02${s}`));
    expect(message(log, 'msg_r11').blocks.map((b) => b.id)).toEqual(['prt_dup', 'prt_dup#3', 'prt_dup#2', 'prt_r11d', '#4', '#5']);
  });

  test('blocks by part type', () => {
    const m01 = message(log, 'msg_r01');
    expect(m01.blocks.map((b) => [b.type, b.type === 'harness' ? b.kind : ''])).toEqual([
      ['text', ''], ['attachment', ''], ['harness', 'file'], ['text', ''], ['harness', 'text'], ['harness', 'agent'], ['harness', 'subtask'],
    ]);
    expect(block(m01, 'prt_r01b')).toMatchObject({ type: 'attachment', mime: 'image/png', name: 'shot.png', ref: '', bytes: 0 });
    expect(block(m01, 'prt_r01d')).toMatchObject({ type: 'text', synthetic: true });
    expect(block(m01, 'prt_r01g')).toMatchObject({ model_visible: true });
    expect(m01.model).toEqual({ provider: 'prov', model: 'model-a', variant: 'high' });

    const m02 = message(log, 'msg_r02');
    expect(m02.blocks.map((b) => (b.type === 'harness' ? `harness:${b.kind}` : b.type === 'step' ? `step:${b.phase}` : b.type))).toEqual([
      'step:start', 'reasoning', 'text', 'tool_call', 'tool_call', 'tool_call', 'tool_call', 'tool_call', 'tool_call', 'harness:patch', 'harness:snapshot', 'harness:retry', 'step:finish',
    ]);
    expect(m02).toMatchObject({ status: 'complete', in_context: true, finish: 'tool_calls', reply_to: 'msg_r01', agent: 'build', error: null });
    expect(m02.usage).toEqual({ input: 10, output: 5, cache_read: 2, cache_write: 3, reasoning: 1, cost: 0.25 });
    expect(m02.model).toEqual({ provider: 'prov', model: 'model-a', variant: 'high' });
  });

  test('tool calls: kinds, results, stripped inputs and cleared outputs', () => {
    const m02 = message(log, 'msg_r02');
    const call = (id: string) => block(m02, id) as ToolCallBlock;
    expect(call('prt_r02d')).toMatchObject({ kind: 'shell', status: 'complete', input: { command: 'ls' }, title: 'ls', result: { content: [{ type: 'text', text: 'a\nb' }], is_error: false, exit_code: 0 } });
    expect(call('prt_r02e').result).toMatchObject({
      content: [{ type: 'text', text: 'Image read' }, { type: 'attachment', ref: '', mime: 'image/png' }],
      model_content: [{ type: 'text', text: '[Old tool result content cleared]' }],
      cleared_at: new Date(T0 + 30_000).toISOString(),
    });
    expect(call('prt_r02f')).toMatchObject({ kind: 'edit', status: 'error', result: { is_error: true, content: [{ type: 'text', text: 'no such file' }], error: { message: 'no such file' } } });
    expect(call('prt_r02g')).toMatchObject({ kind: 'task', status: 'complete' });
    expect(call('prt_r02h')).toMatchObject({ kind: 'shell', input: null, result: { content: [], is_error: false } });
    expect(call('prt_r02i')).toMatchObject({ kind: 'other', name: 'linear_create_issue', input: null, status: 'error', result: { content: [], is_error: true } });
  });

  test('open calls at rest are closed by the closure rule', () => {
    const closed = { status: 'error', result: { is_error: true, synthetic: true, error: { code: 'interrupted' }, content: [{ type: 'text', text: '[Tool execution was interrupted]' }] } };
    const m03 = message(log, 'msg_r03');
    expect(m03).toMatchObject({ status: 'aborted', in_context: true, finish: 'aborted', error: { code: 'MessageAbortedError', message: 'Aborted' } });
    expect(block(m03, 'prt_r03b')).toMatchObject(closed);
    expect(block(m03, 'prt_r03c')).toMatchObject(closed);
    expect(message(log, 'msg_r05')).toMatchObject({ status: 'interrupted', in_context: true, completed_at: null });
    expect(block(message(log, 'msg_r05'), 'prt_r05a')).toMatchObject(closed);
    const pi = fromV1(mainFixture(), { harness: 'pi' });
    expect((block(message(pi, 'msg_r05'), 'prt_r05a') as ToolCallBlock).result!.content).toEqual([{ type: 'text', text: 'No result provided' }]);
    expect(Object.keys(message(pi, 'msg_r05').ext!)).toEqual(['pi']);
  });

  test('a failed attempt is out of context', () => {
    expect(message(log, 'msg_r04')).toMatchObject({ status: 'error', in_context: false, hidden_reason: 'failed_attempt', finish: 'error', error: { code: 'APIError', message: 'rate limited' } });
  });

  test('compaction + summary become one compaction message', () => {
    expect(message(log, 'msg_r06')).toMatchObject({
      kind: 'compaction', role: 'user', status: 'complete', in_context: true, completed_at: new Date(T0 + 20_501).toISOString(),
      blocks: [{ type: 'compaction', id: 'prt_r06a', summary: 'Summary part one. Part two.', first_kept_message_id: 'msg_r05', trigger: 'auto' }],
    });
    expect(message(log, 'msg_r08').blocks[0]).toMatchObject({ first_kept_message_id: null, trigger: 'overflow', summary: 'Second summary.' });
    expect(message(log, 'msg_r14').blocks[0]).toMatchObject({ summary: 'Skewed summary.', first_kept_message_id: 'msg_r12' });
    expect(messages(log).some((m) => m.message_id === 'msg_r13')).toBe(false);
    expect(message(log, 'msg_r10')).toMatchObject({ status: 'interrupted', in_context: false, hidden_reason: 'aborted', blocks: [{ summary: null, trigger: 'manual' }] });
  });

  test('a resolver fills attachment refs and lowers the attachment count', () => {
    const resolved = fromV1(mainFixture(), { resolveAttachment: (p) => (p.url ? { ref: `blob:${p.id}`, bytes: 42, sha256: 'f'.repeat(64) } : null) });
    expect(resolved.grade_counts).toEqual({ tool_input: 2, cut_point: 1, attachment: 0 });
    expect(block(message(resolved, 'msg_r01'), 'prt_r01b')).toMatchObject({ ref: 'blob:prt_r01b', bytes: 42, sha256: 'f'.repeat(64) });
  });
});

describe('toV1 on native v2 records', () => {
  const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'session-log');
  for (const name of ['golden21.v2.json', 'opencode.v2.json', 'pi.v2.json', 'codex.v2.json']) {
    test(`${name}: one v1 row per message (two per completed compaction), each with its parts`, () => {
      const log = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as SessionLog;
      const out = toV1(log);
      const ids = new Set(out.rows.map((r) => r.info.id));
      for (const m of messages(log)) expect(ids.has(m.message_id)).toBe(true);
      for (const r of out.rows) {
        expect(['user', 'assistant']).toContain(r.info.role);
        expect(Array.isArray(r.parts)).toBe(true);
      }
    });
  }
});

describe('validators added with the converter', () => {
  test('a text block with ref and no bytes is rejected', () => {
    const msg = {
      ...json(message(fromV1(mainFixture()), 'msg_r12')),
      blocks: [{ type: 'text', id: 'b0', text: 'preview', ref: 'blob:x' }],
    };
    expect(SessionLogMessageSchema.safeParse(msg).success).toBe(false);
    expect(SessionLogMessageSchema.safeParse({ ...msg, blocks: [{ ...msg.blocks[0], bytes: 300_000 }] }).success).toBe(true);
  });
});
