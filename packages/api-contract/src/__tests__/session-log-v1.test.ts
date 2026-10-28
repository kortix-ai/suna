import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fromV1,
  liveMessageFromV1,
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
    // Aborted with nothing the model sees (step parts only): out of context, not an empty replayed turn.
    assistant(R, 'msg_r15', T0 + 24_500, 'msg_r12', (m) => [stepStart(R, m, 'prt_r15a'), stepFinish(R, m, 'prt_r15b')], {
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } }, finish: undefined, time: { created: T0 + 24_500 },
    }),
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
      { ...base(S, m, `${m}-p2`), type: 'tool', callID: `${m}-p2`, tool: 'find', state: { status: 'completed', input: { pattern: '*.ts' }, output: 'a.ts', title: '*.ts', metadata: {}, time: { start: T0 + 121, end: T0 + 122 } } },
      { ...base(S, m, `${m}-p3`), type: 'tool', callID: `${m}-p3`, tool: 'powershell', state: { status: 'completed', input: { command: 'dir' }, output: 'a.ts', title: 'dir', metadata: {}, time: { start: T0 + 123, end: T0 + 124 } } },
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

  // A daemon adapter runs `fromV1` and then sets its own producer (P2.6), so its records carry
  // the residuals under producer `opencode` or `pi`. `toV1` must be exact on them too (P4.2).
  for (const [name, make, opts] of FIXTURES) {
    const harness = opts?.harness ?? 'opencode';
    test(`toV1 is exact on a journaled record (producer ${harness}): ${name}`, () => {
      const log = json(fromV1(make(), opts));
      for (const t of log.threads) for (const m of t.messages) m.producer = { harness, harness_version: '1.18.23', adapter_version: '1.0.0' };
      expectExact(make(), toV1(log));
    });
  }

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
    const log = fromV1(x);
    expect(json(x)).toStrictEqual(before);
    // Output does not alias input: changing a harness block's data or a tool input leaves the rows alone.
    ((block(message(log, 'msg_r01'), 'prt_r01f') as { data: { name: string } }).data).name = 'changed';
    ((block(message(log, 'msg_r02'), 'prt_r02d') as ToolCallBlock).input as { command: string }).command = 'changed';
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

  test('mapped v2 fields carry the v1 values', () => {
    const m01 = message(log, 'msg_r01');
    const m02 = message(log, 'msg_r02');
    expect(block(m01, 'prt_r01a')).toEqual({ type: 'text', id: 'prt_r01a', text: 'look at this', ext: expect.anything() });
    expect(block(m02, 'prt_r02c')).toMatchObject({ type: 'text', text: 'Here is the answer.' });
    expect(block(m02, 'prt_r02b')).toMatchObject({ type: 'reasoning', text: 'thinking' });
    expect(m01).toMatchObject({ role: 'user', created_at: new Date(T0 + 10_000).toISOString(), completed_at: new Date(T0 + 10_000).toISOString(), agent: 'build', usage: null, finish: null });
    expect(m02).toMatchObject({ role: 'assistant', created_at: new Date(T0 + 11_000).toISOString(), completed_at: new Date(T0 + 11_500).toISOString() });
    expect(block(m02, 'prt_r02d')).toMatchObject({
      call_id: 'call_prt_r02d', name: 'bash', started_at: new Date(T0 + 11_010).toISOString(), ended_at: new Date(T0 + 11_020).toISOString(),
    });
    expect(block(m02, 'prt_r02f')).toMatchObject({ started_at: new Date(T0 + 11_050).toISOString(), ended_at: new Date(T0 + 11_060).toISOString() });
    expect(message(log, 'msg_r11')).toMatchObject({ status: 'complete', finish: null, error: null }); // 'content-filter' is not a v2 finish
    expect(message(log, 'msg_c02')).toMatchObject({ thread_id: CHILD, reply_to: 'msg_c01', agent: 'general', seq: 2 });
    expect(message(log, 'msg_c01')).toMatchObject({ thread_id: CHILD, model: { provider: 'prov', model: 'model-a' }, seq: 1 });
    expect(log.created_at).toBe(new Date(T0).toISOString());
    expect(log.threads[2]).toMatchObject({ created_at: new Date(T0 + 11_080).toISOString(), agent: 'general' });
  });

  test('blocks by part type', () => {
    const m01 = message(log, 'msg_r01');
    expect(m01.blocks.map((b) => [b.type, b.type === 'harness' ? b.kind : ''])).toEqual([
      ['text', ''], ['attachment', ''], ['harness', 'file'], ['text', ''], ['harness', 'text'], ['harness', 'agent'], ['harness', 'subtask'],
    ]);
    // F13: unresolved, so no ref and no bytes; the v1 url stays.
    expect(block(m01, 'prt_r01b')).toEqual({ type: 'attachment', id: 'prt_r01b', mime: 'image/png', name: 'shot.png', url: 'kortix-attachment://p/s/att1', ext: expect.anything() });
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
      content: [{ type: 'text', text: 'Image read' }, { type: 'attachment', mime: 'image/png', url: 'kortix-attachment://p/s/att2' }],
      model_content: [{ type: 'text', text: '[Old tool result content cleared]' }],
      cleared_at: new Date(T0 + 30_000).toISOString(),
    });
    expect(call('prt_r02f')).toMatchObject({ kind: 'edit', status: 'error', result: { is_error: true, content: [{ type: 'text', text: 'no such file' }], error: { message: 'no such file' } } });
    expect(call('prt_r02g')).toMatchObject({ kind: 'task', status: 'complete' });
    expect(call('prt_r02h')).toMatchObject({ kind: 'shell', input: null, result: { content: [], is_error: false } });
    expect(call('prt_r02i')).toMatchObject({ kind: 'mcp', name: 'linear_create_issue', input: null, status: 'error', result: { content: [], is_error: true } });
    const pi = fromV1(piFixture(), { harness: 'pi' });
    expect(message(pi, 'msg_p02').blocks.map((b) => (b.type === 'tool_call' ? b.kind : b.type))).toEqual(['text', 'read', 'glob', 'shell']);
  });

  test('open calls at rest are closed by the closure rule', () => {
    const closed = { status: 'error', result: { is_error: true, synthetic: true, error: { code: 'interrupted' }, content: [{ type: 'text', text: '[Tool execution was interrupted]' }] } };
    const m03 = message(log, 'msg_r03');
    // error.code is the daemon's TurnErrorCode when the row has one ('aborted'), else the v1 class name.
    expect(m03).toMatchObject({ status: 'aborted', in_context: true, finish: 'aborted', error: { code: 'aborted', message: 'Aborted' } });
    expect(message(log, 'msg_r15')).toMatchObject({ status: 'aborted', in_context: false, hidden_reason: 'aborted', error: { code: 'MessageAbortedError' } });
    expect(block(m03, 'prt_r03b')).toMatchObject(closed);
    expect(block(m03, 'prt_r03c')).toMatchObject(closed);
    expect(message(log, 'msg_r05')).toMatchObject({ status: 'interrupted', in_context: true, completed_at: null });
    expect(block(message(log, 'msg_r05'), 'prt_r05a')).toMatchObject(closed);
    const pi = fromV1(mainFixture(), { harness: 'pi' });
    expect((block(message(pi, 'msg_r05'), 'prt_r05a') as ToolCallBlock).result!.content).toEqual([{ type: 'text', text: 'No result provided' }]);
    expect(Object.keys(message(pi, 'msg_r05').ext!)).toEqual(['pi']);
  });

  test('a failed attempt is out of context', () => {
    expect(message(log, 'msg_r04')).toMatchObject({ status: 'error', in_context: false, hidden_reason: 'failed_attempt', finish: 'error', error: { code: 'rate_limit', message: 'rate limited' } });
  });

  test('compaction + summary become one compaction message', () => {
    expect(message(log, 'msg_r06')).toMatchObject({
      kind: 'compaction', role: 'user', status: 'complete', in_context: true, completed_at: new Date(T0 + 20_501).toISOString(),
      blocks: [{ type: 'compaction', id: 'prt_r06a', summary: 'Summary part one. Part two.', first_kept_message_id: 'msg_r05', trigger: 'auto' }],
    });
    expect(message(log, 'msg_r08').blocks[0]).toMatchObject({ first_kept_message_id: null, trigger: 'overflow', summary: 'Second summary.' });
    expect(message(log, 'msg_r14').blocks[0]).toMatchObject({ summary: 'Skewed summary.', first_kept_message_id: 'msg_r12' });
    expect(messages(log).some((m) => m.message_id === 'msg_r13')).toBe(false);
    expect(message(log, 'msg_r10')).toMatchObject({ status: 'interrupted', in_context: false, blocks: [{ summary: null, trigger: 'manual' }] });
    expect(message(log, 'msg_r10').hidden_reason).toBeUndefined(); // nobody stopped it, nothing failed
  });

  test('a resolver fills attachment refs and lowers the attachment count', () => {
    const resolved = fromV1(mainFixture(), { resolveAttachment: (p) => (p.url ? { ref: `blob:${p.id}`, bytes: 42, sha256: 'f'.repeat(64) } : null) });
    expect(resolved.grade_counts).toEqual({ tool_input: 2, cut_point: 1, attachment: 0 });
    expect(block(message(resolved, 'msg_r01'), 'prt_r01b')).toMatchObject({ ref: 'blob:prt_r01b', bytes: 42, sha256: 'f'.repeat(64), url: 'kortix-attachment://p/s/att1' });
  });
});

describe('fromV1 live: the turn that runs is not closed', () => {
  const live = fromV1(mainFixture(), { live: true });

  test('toV1(fromV1(x, { live })) deep-equals x for every fixture', () => {
    for (const [, make, opts] of FIXTURES) expectExact(make(), roundTrip(make(), { ...opts, live: true }));
  });

  test('an open call keeps its v1 status and has no result; its residual keeps what the block does not carry', () => {
    const m03 = message(live, 'msg_r03');
    expect(block(m03, 'prt_r03b')).toMatchObject({ status: 'running', input: { command: 'sleep 9' }, title: 'sleep 9' });
    // A call that streams its input: the text so far is its input (OpenCode keeps it in `raw`).
    expect(block(m03, 'prt_r03c')).toMatchObject({ status: 'pending', input: '{"pattern":' });
    expect((block(m03, 'prt_r03b') as ToolCallBlock).result).toBeUndefined();
    expect((block(m03, 'prt_r03c') as ToolCallBlock).result).toBeUndefined();
    // The raw partial input of the pending call survives in the residual.
    const back = toV1(json(live)).rows.find((r) => r.info.id === 'msg_r03')!;
    expect(back.parts.find((p) => p.id === 'prt_r03c')).toMatchObject({ state: { status: 'pending', raw: '{"pattern":' } });
  });

  test('a running task keeps its child session id in the residual (no closure, no lost metadata)', () => {
    const row = assistant(ROOT, 'msg_live', T0 + 30_000, 'msg_r01', (m) => [
      tool(ROOT, m, 'prt_live', 'task', { status: 'running', input: { description: 'sub' }, title: 'sub', metadata: { sessionId: CHILD }, time: { start: T0 + 30_001 } }),
    ], { finish: undefined, time: { created: T0 + 30_000 } });
    const log = fromV1({ session_id: 's', root_id: ROOT, rows: [row] }, { live: true });
    expect(message(log, 'msg_live')).toMatchObject({ status: 'streaming', completed_at: null, finish: null, in_context: true });
    expect(block(message(log, 'msg_live'), 'prt_live')).toMatchObject({ status: 'running', started_at: new Date(T0 + 30_001).toISOString() });
    expect(toV1(json(log)).rows[0]!.parts[0]).toEqual(json(row.parts[0]));
  });

  test('round trip of a live turn: pending and running calls, an open question, an open reply', () => {
    const rows: V1Row[] = [
      user(ROOT, 'msg_l01', T0, (m) => [text(ROOT, m, 'prt_l01a', 'go')]),
      assistant(ROOT, 'msg_l02', T0 + 100, 'msg_l01', (m) => [
        tool(ROOT, m, 'prt_l02a', 'write', { status: 'pending', input: {}, raw: '{"filePath":"/w/a.ts","content":"exp' }),
        tool(ROOT, m, 'prt_l02b', 'bash', { status: 'running', input: { command: 'sleep 1', description: 'Waits' }, title: 'Waits', metadata: { output: 'partial', description: 'Waits' }, time: { start: T0 + 110 } }),
        tool(ROOT, m, 'prt_l02c', 'question', { status: 'running', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] }, metadata: {}, time: { start: T0 + 120 } }),
        tool(ROOT, m, 'prt_l02d', 'task', { status: 'running', input: { description: 'sub', prompt: 'p', subagent_type: 'general' }, title: 'sub', metadata: { sessionId: CHILD, model }, time: { start: T0 + 130 } }),
      ], { finish: undefined, time: { created: T0 + 100 } }),
    ];
    const x: V1Transcript = { session_id: 'sess-live', root_id: ROOT, rows };
    expectExact(x, roundTrip(x, { live: true }));
    const m = message(fromV1(json(x), { live: true }), 'msg_l02');
    expect(m.status).toBe('streaming');
    expect(m.blocks.map((b) => (b as ToolCallBlock).status)).toEqual(['pending', 'running', 'running', 'running']);
    expect((m.blocks[0] as ToolCallBlock).input).toBe('{"filePath":"/w/a.ts","content":"exp');
  });

  test('an open reply is streaming; an aborted reply with open calls streams while they are open; a failed attempt keeps its error status', () => {
    expect(message(live, 'msg_r05')).toMatchObject({ status: 'streaming', in_context: true, completed_at: null });
    expect(block(message(live, 'msg_r05'), 'prt_r05a')).toMatchObject({ status: 'pending', input: { url: 'https://example.com' } });
    // msg_r03 is aborted with a running and a pending call, in context: `aborted` with open calls fails rule C2 (an
    // in-context message that is not streaming holds no open call), so the live view streams it until the calls close.
    expect(message(live, 'msg_r03')).toMatchObject({ status: 'streaming', in_context: true, error: { code: 'aborted', message: 'Aborted' } });
    expect(SessionLogMessageSchema.safeParse(message(live, 'msg_r03')).success).toBe(true);
    expect(message(live, 'msg_r04')).toMatchObject({ status: 'error', in_context: false });
  });

  test('a complete reply with an open call streams (pi completes a reply before its calls run); the round trip stays exact', () => {
    const row = assistant(ROOT, 'msg_pi_open', T0 + 40_000, 'msg_r01', (m) => [
      tool(ROOT, m, 'prt_pi_open', 'bash', { status: 'running', input: { command: 'make' }, title: 'make', time: { start: T0 + 40_001 } }),
    ], { finish: 'tool-calls', time: { created: T0 + 40_000, completed: T0 + 40_500 } });
    const x: V1Transcript = { session_id: 's', root_id: ROOT, rows: [row] };
    const m = message(fromV1(json(x), { live: true }), 'msg_pi_open');
    expect(m).toMatchObject({ status: 'streaming', in_context: true, finish: 'tool_calls' });
    expect(SessionLogMessageSchema.safeParse(m).success).toBe(true);
    expectExact(x, roundTrip(x, { live: true }));
    // At rest the closure rule closes the call and the reply stays complete.
    expect(message(fromV1(json(x)), 'msg_pi_open')).toMatchObject({ status: 'complete', blocks: [{ status: 'error', result: { synthetic: true } }] });
  });

  test('an aborted live row with a visible block and an open call streams (it stays in context, C2); an errored one keeps `error` (out of context)', () => {
    const open = (m: string) => [text(ROOT, m, 'prt_lv_t', 'partial'), tool(ROOT, m, 'prt_lv_c', 'bash', { status: 'running', input: { command: 'sleep 9' }, time: { start: T0 + 50_001 } })];
    const aborted = assistant(ROOT, 'msg_lv_abort', T0 + 50_000, 'msg_r01', open, { finish: undefined, time: { created: T0 + 50_000 }, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
    const failed = assistant(ROOT, 'msg_lv_fail', T0 + 51_000, 'msg_r01', open, { finish: undefined, time: { created: T0 + 51_000 }, error: { name: 'APIError', data: { message: 'boom', isRetryable: false } } });
    const x: V1Transcript = { session_id: 's', root_id: ROOT, rows: [aborted, failed] };
    const live = fromV1(json(x), { live: true });
    expect(message(live, 'msg_lv_abort')).toMatchObject({ status: 'streaming', in_context: true, error: { message: 'Aborted' } });
    expect(message(live, 'msg_lv_fail')).toMatchObject({ status: 'error', in_context: false, hidden_reason: 'failed_attempt' });
    for (const id of ['msg_lv_abort', 'msg_lv_fail']) {
      expect((block(message(live, id), 'prt_lv_c') as ToolCallBlock).status).toBe('running');
      expect(SessionLogMessageSchema.safeParse(message(live, id)).success).toBe(true);
    }
    expectExact(x, roundTrip(x, { live: true }));
    // At rest both are closed: the abort stays aborted, the failure stays an error.
    expect(message(fromV1(json(x)), 'msg_lv_abort')).toMatchObject({ status: 'aborted', blocks: [{}, { status: 'error', result: { synthetic: true } }] });
  });

  test('a compaction whose summary has not arrived is streaming, not interrupted', () => {
    expect(message(live, 'msg_r10')).toMatchObject({ kind: 'compaction', status: 'streaming' });
  });

  test('settled calls and messages are the same as at rest', () => {
    const rest = fromV1(mainFixture());
    for (const id of ['msg_r01', 'msg_r02', 'msg_r04', 'msg_r06', 'msg_r11', 'msg_c02']) expect(message(live, id)).toEqual(message(rest, id));
  });
});

describe('liveMessageFromV1: a message of the running turn keeps its v1 residual (P4.7)', () => {
  // The frames so far of one reply: a running task, a running bash call, a pending call that streams its input.
  const reply = assistant(ROOT, 'msg_lv02', T0 + 100, 'msg_lv01', (m) => [
    tool(ROOT, m, 'prt_lv02a', 'task', { status: 'running', input: { description: 'sub', prompt: 'p', subagent_type: 'general' }, title: 'sub', metadata: { sessionId: CHILD }, time: { start: T0 + 110 } }),
    tool(ROOT, m, 'prt_lv02b', 'bash', { status: 'running', input: { command: 'ls -la', description: 'Lists' }, title: 'Lists', metadata: { command: 'ls -la', output: 'total 0' }, time: { start: T0 + 120 } }),
    tool(ROOT, m, 'prt_lv02c', 'write', { status: 'pending', input: {}, raw: '{"filePath":"/w/a.ts","content":"exp' }),
  ], { finish: undefined, time: { created: T0 + 100 } });
  const live = liveMessageFromV1(json({ info: reply.info, parts: reply.parts }), { seq: 2 });
  /** The v1 parts `toV1` rebuilds from the live message, in a v1-derived thread. */
  const partsBack = (m: SessionLogMessage) => {
    const log = fromV1({ session_id: 's', root_id: ROOT, rows: [json(reply)] }, { live: true });
    log.threads[0]!.messages = [m];
    return toV1(json(log)).rows[0]!.parts;
  };

  test('the message streams; the open calls stay open with no result', () => {
    expect(live).toMatchObject({ seq: 2, status: 'streaming', completed_at: null, finish: null });
    expect(live.blocks.map((b) => [(b as ToolCallBlock).status, (b as ToolCallBlock).result])).toEqual([['running', undefined], ['running', undefined], ['pending', undefined]]);
  });

  test('a running task keeps state.metadata.sessionId: toV1 restores the part', () => {
    expect(partsBack(live)[0]).toEqual(json(reply.parts[0]));
    expect((partsBack(live)[0] as { state: { metadata: unknown } }).state.metadata).toEqual({ sessionId: CHILD });
  });

  test('a running bash call keeps state.metadata.command: toV1 restores the part', () => {
    expect(partsBack(live)[1]).toEqual(json(reply.parts[1]));
  });

  test('a pending call carries its partial input as a string; toV1 restores raw and the empty input', () => {
    expect((live.blocks[2] as ToolCallBlock).input).toBe('{"filePath":"/w/a.ts","content":"exp');
    expect(partsBack(live)[2]).toEqual(json(reply.parts[2]));
    expect(SessionLogMessageSchema.safeParse(live).success).toBe(true);
  });

  test('the whole live message round-trips: toV1 gives back the frames', () => {
    expect(partsBack(live)).toEqual(json(reply.parts));
  });

  test('pi completes a reply before its calls run: a completed reply with an open call streams, and toV1 keeps its completion', () => {
    const pi = assistant(ROOT, 'msg_lv03', T0 + 200, 'msg_lv01', (m) => [
      tool(ROOT, m, 'prt_lv03a', 'bash', { status: 'running', input: { command: 'echo hi' }, metadata: { output: '' }, time: { start: T0 + 210 } }),
    ], { finish: undefined });
    const m = liveMessageFromV1(json({ info: pi.info, parts: pi.parts }), { seq: 3 }, 'pi');
    expect(m).toMatchObject({ status: 'streaming', in_context: true });
    expect(SessionLogMessageSchema.safeParse(m).success).toBe(true);
    const log = fromV1({ session_id: 's', root_id: ROOT, rows: [json(pi)] }, { harness: 'pi', live: true });
    log.threads[0]!.messages = [m];
    expect(toV1(json(log)).rows).toEqual([json(pi)]);
  });
});

describe('a mirror without a usable root keeps its conversation in context', () => {
  const inContext = (log: SessionLog) => log.threads[0].messages.map((m) => [m.message_id, m.in_context, m.hidden_reason]);
  const expected = [['msg_p01', true, undefined], ['msg_p02', true, undefined], ['msg_p03', true, undefined]];
  test('root_id null: the latest row\'s runtime session is the root thread', () => {
    const log = fromV1({ ...piFixture(), root_id: null });
    expect(log.threads[0].thread_id).toBe('ses_pi00000000000000000001');
    expect(inContext(log)).toEqual(expected);
    expect(toV1(log).root_id).toBeNull();
  });
  test('rows without a runtime session id: the null group is the root thread', () => {
    const x = { ...piFixture(), rows: piFixture().rows.map((r) => ({ ...r, runtime_session_id: null })) };
    expect(inContext(fromV1(x))).toEqual(expected);
    expect(fromV1({ ...x, root_id: null }).threads[0].thread_id).toBe('sess-synthetic-pi');
    expect(inContext(fromV1({ ...x, root_id: null }))).toEqual(expected);
  });
  test('a stale root (a re-pin before the first capture) falls back to the latest row, an older root stays superseded', () => {
    const old = user(OLD, 'msg_old', T0 - 1_000, (m) => [text(OLD, m, 'prt_old', 'before the re-pin')]);
    const x = { ...piFixture(), root_id: 'ses_fresh00000000000000001', rows: [old, ...piFixture().rows] };
    const log = fromV1(x);
    expect(inContext(log)).toEqual([['msg_old', false, 'superseded'], ...expected]);
    expect(toV1(json(log)).root_id).toBe('ses_fresh00000000000000001');
    expectExact(x, roundTrip(x));
  });
  test('a runtime session id of \'\' is never a child (a substring match on it would name every call)', () => {
    const x = mainFixture();
    x.rows.push(user('', 'msg_empty', T0 + 30_000, (m) => [text('', m, 'prt_empty', 'x')]));
    const log = fromV1(x);
    expect(log.threads.some((t) => t.thread_id === '')).toBe(false);
    expect(message(log, 'msg_empty')).toMatchObject({ thread_id: ROOT, in_context: false, hidden_reason: 'superseded' });
    expectExact(x, roundTrip(x));
  });
});

describe('toV1 on native v2 records', () => {
  const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'session-log');
  for (const name of ['golden21.v2.json', 'opencode.v2.json', 'pi.v2.json', 'codex.v2.json']) {
    test(`${name}: one v1 row per message (two per completed compaction), each with its parts`, () => {
      const log = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as SessionLog;
      const out = toV1(log);
      const ids = new Set(out.rows.map((r) => r.info.id));
      for (const m of messages(log)) expect(ids.has(m.message_id)).toBe(m.role !== 'system' && m.kind !== 'context');
      for (const r of out.rows) {
        expect(['user', 'assistant']).toContain(r.info.role);
        expect(Array.isArray(r.parts)).toBe(true);
      }
    });
  }

  test('pi.v2.json: no user row for a system or context message', () => {
    const log = JSON.parse(readFileSync(join(FIXTURE_DIR, 'pi.v2.json'), 'utf8')) as SessionLog;
    const hidden = messages(log).filter((m) => m.kind === 'context' || m.role === 'system').map((m) => m.message_id);
    expect(hidden.length).toBeGreaterThan(0);
    expect(toV1(log).rows.filter((r) => hidden.includes(r.info.id))).toEqual([]);
  });

  test('a harness block on a native thread (no v1 ext, as the pi adapter writes) is not passed through as a v1 part', () => {
    const log = json(fromV1(piFixture(), { harness: 'pi' }));
    delete log.threads[0].ext;
    const m = log.threads[0].messages[1];
    m.producer = { harness: 'pi', harness_version: '1.0.3', adapter_version: '1' };
    m.blocks.push({ type: 'harness', id: 'h1', harness: 'pi', kind: 'custom', data: { anything: true }, model_visible: false });
    const row = toV1(log).rows.find((r) => r.info.id === m.message_id)!;
    expect(row.parts.some((p) => (p as { anything?: boolean }).anything)).toBe(false);
  });

  test('a nested_part block (a script\'s nested call, model-invisible) is its v1 part under the block\'s ids, in block order, on any harness', () => {
    const log = json(fromV1(piFixture(), { harness: 'pi' }));
    delete log.threads[0].ext;
    const m = log.threads[0].messages[1];
    m.producer = { harness: 'pi', harness_version: '1.2.0', adapter_version: '1.2.0' };
    const part = { type: 'tool', callID: 'call_s/1', tool: 'image_gen', state: { status: 'completed', input: { prompts: ['a'] }, output: '{"images":[]}', title: 'image_gen', metadata: {}, time: { start: 1, end: 2 } } };
    m.blocks.splice(1, 0, { type: 'harness', id: 'h_nested', harness: 'pi', kind: 'nested_part', data: { parent_call_id: 'call_s', part: { ...part, id: 'stale', messageID: 'stale' } }, model_visible: false });
    const row = toV1(log).rows.find((r) => r.info.id === m.message_id)!;
    const sessionID = (row.info as { sessionID?: string }).sessionID;
    expect(row.parts[1] as unknown).toEqual({ ...part, id: 'h_nested', messageID: m.message_id, ...(sessionID !== undefined && { sessionID }) });
  });

  test('a native tool call: its display data is the v1 state.metadata, as the harness v1 part has it (result.details, else the adapter ext details)', () => {
    const log = JSON.parse(readFileSync(join(FIXTURE_DIR, 'pi.v2.json'), 'utf8')) as SessionLog;
    const parts = toV1(log).rows.flatMap((r) => r.parts as Array<{ type: string; tool?: string; state?: { status: string; metadata?: unknown } }>);
    const task = parts.find((p) => p.tool === 'task')!;
    expect(task.state!.metadata).toMatchObject({ sessionId: 'ses_pilive0000000000000001-child1' });
    const call = log.threads[0]!.messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_call' && b.name === 'task') as { result: { details?: unknown }; ext?: unknown };
    call.ext = { pi: { version: '1.0.3', native_id: 'r1', data: { details: { answers: [['Yes']] } } } };
    delete call.result.details;
    const moved = toV1(log).rows.flatMap((r) => r.parts as typeof parts).find((p) => p.tool === 'task')!;
    expect(moved.state!.metadata).toEqual({ answers: [['Yes']] });
  });

  test('toV1 does not alias its input', () => {
    const log = fromV1(mainFixture());
    const out = toV1(log);
    (out.rows.find((r) => r.info.id === 'msg_r01')!.parts[5] as { name: string }).name = 'changed';
    expect(((block(message(log, 'msg_r01'), 'prt_r01f') as { data: { name: string } }).data).name).toBe('build');
  });
});

describe('validators added with the converter', () => {
  test('an attachment has ref and bytes, or neither (F13)', () => {
    const msg = json(message(fromV1(mainFixture()), 'msg_r12'));
    const att = { type: 'attachment', id: 'a0', mime: 'image/png' };
    expect(SessionLogMessageSchema.safeParse({ ...msg, blocks: [att] }).success).toBe(true);
    expect(SessionLogMessageSchema.safeParse({ ...msg, blocks: [{ ...att, ref: 'blob:x', bytes: 3 }] }).success).toBe(true);
    expect(SessionLogMessageSchema.safeParse({ ...msg, blocks: [{ ...att, ref: 'blob:x' }] }).success).toBe(false);
    expect(SessionLogMessageSchema.safeParse({ ...msg, blocks: [{ ...att, bytes: 3 }] }).success).toBe(false);
  });

  test('a text block with ref and no bytes is rejected', () => {
    const msg = {
      ...json(message(fromV1(mainFixture()), 'msg_r12')),
      blocks: [{ type: 'text', id: 'b0', text: 'preview', ref: 'blob:x' }],
    };
    expect(SessionLogMessageSchema.safeParse(msg).success).toBe(false);
    expect(SessionLogMessageSchema.safeParse({ ...msg, blocks: [{ ...msg.blocks[0], bytes: 300_000 }] }).success).toBe(true);
  });
});
