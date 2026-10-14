import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, Part } from '../runtime/runtime-types';
import { EMPTY_SESSION_LOG_STATE, applySessionLogEvent, applySessionLogPage, selectSessionLogThread, type SessionLogState } from './store';
import type { SessionLog } from './types';
import { fromV1, toV1, type V1Transcript } from './v1';
import { sessionLogOfV1Rows, sessionLogRowsFor, sessionLogThreadWithV1Rows, type V1MessageRow } from './v1-view';

const CONTRACT_FIXTURES = join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log');
const fixtures: Array<[string, SessionLog]> = readdirSync(CONTRACT_FIXTURES)
  .filter((name) => name.endsWith('.v2.json'))
  .map((name) => [name, JSON.parse(readFileSync(join(CONTRACT_FIXTURES, name), 'utf8'))]);
const golden: SessionLog = JSON.parse(readFileSync(join(CONTRACT_FIXTURES, 'golden21.v2.json'), 'utf8'));
const ROOT = golden.threads[0]!.thread_id;

/** `log` as `fromV1` marks a converted record: every thread carries the `kortix.transcript.v1` ext. */
function asV1Threads(log: SessionLog): SessionLog {
  const out = structuredClone(log);
  for (const t of out.threads) t.ext = { ...t.ext, opencode: { version: 'kortix.transcript.v1', native_id: t.thread_id } };
  return out;
}
const v1Golden = asV1Threads(golden);

/** The store after reading every thread of `log` (one page per thread). */
function stateOf(log: SessionLog): SessionLogState {
  const { threads, ...session } = structuredClone(log);
  const heads = threads.map(({ messages: _m, ...head }) => head);
  return threads.reduce(
    (state, thread) => applySessionLogPage(state, { session, generation: 1, threads: heads, thread_id: thread.thread_id, messages: thread.messages, has_more: false }),
    EMPTY_SESSION_LOG_STATE,
  );
}
const rowsOfV1 = (v1: V1Transcript): V1MessageRow[] => v1.rows.map((r) => ({ info: r.info as unknown as Message, parts: r.parts as unknown as Part[] }));
const ev = (type: string, properties: unknown) => ({ type, properties });
const NONE: V1MessageRow[] = [];

describe('sessionLogRowsFor: the v1 rows of a v2 thread', () => {
  for (const [name, native] of fixtures) {
    test(`${name}: a native thread (no kortix.transcript.v1 ext, as pi writes) reads as toV1 of that thread, by its thread id`, () => {
      const logs = { kses_1: stateOf(native) };
      for (const thread of native.threads) {
        const expected = rowsOfV1(toV1({ ...native, threads: [thread] }));
        expect(sessionLogRowsFor(logs, thread.thread_id, NONE)).toEqual(expected);
      }
    });
    test(`${name}: a thread fromV1 marked reads as toV1 of that thread`, () => {
      const log = asV1Threads(native);
      const logs = { kses_1: stateOf(log) };
      for (const thread of log.threads) {
        const expected = rowsOfV1(toV1({ ...log, threads: [thread] }));
        expect(sessionLogRowsFor(logs, thread.thread_id, NONE)).toEqual(expected);
      }
    });
  }

  test('a record fromV1 built reads back as the exact v1 rows (the converted path)', () => {
    const sid = 'ses_view0000000000000000001';
    const base = { sessionID: sid };
    const v1: V1Transcript = {
      session_id: 'kses_view',
      root_id: sid,
      rows: [
        {
          runtime_session_id: sid,
          info: { id: 'msg_v01', ...base, role: 'user', time: { created: 1_790_000_000_000 }, agent: 'build', model: { providerID: 'prov', modelID: 'model-a' } } as never,
          parts: [{ id: 'prt_v01a', ...base, messageID: 'msg_v01', type: 'text', text: 'hello' }] as never,
        },
        {
          runtime_session_id: sid,
          info: {
            id: 'msg_v02', ...base, role: 'assistant', time: { created: 1_790_000_001_000, completed: 1_790_000_002_000 }, parentID: 'msg_v01',
            modelID: 'model-a', providerID: 'prov', mode: 'build', agent: 'build', path: { cwd: '/w', root: '/w' }, cost: 0.1,
            tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop', extra_field: { kept: true },
          } as never,
          parts: [
            { id: 'prt_v02a', ...base, messageID: 'msg_v02', type: 'step-start', snapshot: 'abc' },
            { id: 'prt_v02b', ...base, messageID: 'msg_v02', type: 'text', text: 'hi there', time: { start: 1, end: 2 } },
            { id: 'prt_v02c', ...base, messageID: 'msg_v02', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', title: 'ls', metadata: { exit: 0 }, time: { start: 3, end: 4 } } },
          ] as never,
        },
      ],
    };
    expect(sessionLogRowsFor({ kses_view: stateOf(fromV1(v1)) }, sid, NONE)).toEqual(rowsOfV1(v1));
  });
});

describe('sessionLogRowsFor: merged with the v1 store rows', () => {
  const row = (id: string, created: number | undefined, text: string): V1MessageRow => ({
    info: { id, sessionID: ROOT, role: 'assistant', ...(created !== undefined && { time: { created } }) } as unknown as Message,
    parts: [{ id: `${id}-p`, sessionID: ROOT, messageID: id, type: 'text', text } as unknown as Part],
  });

  test('no v2 thread for the runtime session: the v1 rows, as the same array', () => {
    const v1Rows = [row('msg_x', 1, 'x')];
    expect(sessionLogRowsFor({}, ROOT, v1Rows)).toBe(v1Rows);
    expect(sessionLogRowsFor({ kses_1: stateOf(v1Golden) }, 'ses_unknown', v1Rows)).toBe(v1Rows);
  });

  test('v2 wins for its ids; a v1-only row (the live turn, an optimistic send) keeps its place by time; a tombstoned id stays out', () => {
    let state = stateOf(v1Golden);
    const v2 = v1Golden.threads[0]!.messages;
    const deleted = v2[1]!.message_id;
    state = applySessionLogEvent(state, ev('log.message', { message_id: deleted, rev: Number.MAX_SAFE_INTEGER }));
    const last = Date.parse(v2.at(-1)!.created_at);
    const v1Rows = [
      row(v2[0]!.message_id, Date.parse(v2[0]!.created_at), 'stale v1 copy'),
      row(deleted, Date.parse(v2[1]!.created_at), 'deleted in v2'),
      row('msg_zz_live', last + 1_000, 'streaming now'),
      row('msg_optimistic', undefined, 'just sent'),
    ];
    const merged = sessionLogRowsFor({ kses_1: state }, ROOT, v1Rows);
    const ids = merged.map((r) => r.info.id);
    expect(ids).not.toContain(deleted);
    expect(ids.slice(-2)).toEqual(['msg_zz_live', 'msg_optimistic']);
    expect(merged.find((r) => r.info.id === v2[0]!.message_id)!.parts).not.toEqual(v1Rows[0]!.parts);
    expect(merged.slice(0, -2)).toEqual(sessionLogRowsFor({ kses_1: state }, ROOT, NONE));
  });

  test('rows keep their identity while their message is unchanged', () => {
    const state = stateOf(v1Golden);
    const v1Rows: V1MessageRow[] = [];
    const first = sessionLogRowsFor({ kses_1: state }, ROOT, v1Rows);
    expect(sessionLogRowsFor({ kses_1: state }, ROOT, v1Rows)).toBe(first);
    const target = v1Golden.threads[0]!.messages.find((m) => m.blocks.some((b) => b.type === 'text'))!;
    const block = target.blocks.find((b) => b.type === 'text')!;
    const next = applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: target.message_id, block_id: block.id, delta: '…' }));
    const second = sessionLogRowsFor({ kses_1: next }, ROOT, v1Rows);
    expect(second).not.toBe(first);
    second.forEach((r, i) => {
      if (r.info.id === target.message_id) expect(r).not.toBe(first[i]);
      else expect(r).toBe(first[i]!);
    });
  });

  test('a log.thread upsert (a new head object, the same runtime id) keeps every row', () => {
    const state = stateOf(v1Golden);
    const first = sessionLogRowsFor({ kses_1: state }, ROOT, NONE);
    const { messages: _m, ...head } = v1Golden.threads[0]!;
    const renamed = applySessionLogEvent(state, ev('log.thread', { ...head, title: 'Renamed' }));
    const second = sessionLogRowsFor({ kses_1: renamed }, ROOT, NONE);
    expect(second).toHaveLength(first.length);
    second.forEach((r, i) => expect(r).toBe(first[i]!));
  });
});

describe('sessionLogThreadWithV1Rows: a v2 thread with the v1 rows the log lacks (an optimistic send)', () => {
  const optimistic = (id: string, created: number, text: string): V1MessageRow => ({
    info: { id, sessionID: ROOT, role: 'user', time: { created }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } as unknown as Message,
    parts: [{ id: `${id}-p`, sessionID: ROOT, messageID: id, type: 'text', text } as unknown as Part],
  });

  test('a row the log holds or tombstoned stays out; an optimistic send is appended as a fromV1 user message', () => {
    let state = stateOf(v1Golden);
    const v2 = v1Golden.threads[0]!.messages;
    const deleted = v2[1]!.message_id;
    state = applySessionLogEvent(state, ev('log.message', { message_id: deleted, rev: Number.MAX_SAFE_INTEGER }));
    const thread = selectSessionLogThread(state)!;
    const last = Date.parse(v2.at(-1)!.created_at);
    const v1Rows = [optimistic(v2[0]!.message_id, last, 'stale copy'), optimistic(deleted, last, 'deleted'), optimistic('msg_optimistic', last + 1_000, 'just sent')];
    const merged = sessionLogThreadWithV1Rows(state, thread, v1Rows);
    expect(merged.messages.slice(0, -1)).toEqual(thread.messages);
    expect(merged.messages.at(-1)).toMatchObject({
      message_id: 'msg_optimistic', thread_id: ROOT, role: 'user', kind: 'turn', status: 'complete', in_context: true,
      seq: thread.messages.at(-1)!.seq + 1, created_at: new Date(last + 1_000).toISOString(), blocks: [{ type: 'text', id: 'msg_optimistic-p', text: 'just sent' }],
    });
    expect({ ...merged, messages: [] }).toEqual({ ...thread, messages: [] });
  });

  test('a stub whose echo id the log holds (a re-minted prompt) stays out, in the thread and in the v1 rows', () => {
    const state = stateOf(v1Golden);
    const thread = selectSessionLogThread(state)!;
    const echo = thread.messages[0]!.message_id;
    const stub = optimistic('msg_stub', 1, 'sent');
    const echoOf = (id: string) => (id === 'msg_stub' ? echo : undefined);
    expect(sessionLogThreadWithV1Rows(state, thread, [stub], echoOf)).toBe(thread);
    expect(sessionLogThreadWithV1Rows(state, thread, [stub]).messages.at(-1)!.message_id).toBe('msg_stub');
    const rows = sessionLogRowsFor({ kses_1: state }, ROOT, [stub], echoOf);
    expect(rows.map((r) => r.info.id)).not.toContain('msg_stub');
    expect(sessionLogRowsFor({ kses_1: state }, ROOT, [stub]).map((r) => r.info.id)).toContain('msg_stub');
  });

  test('a compaction marker and its summary row the log lacks (pi: a failed compaction is not in its store) are one message, as on v1', () => {
    const state = stateOf(golden);
    const thread = selectSessionLogThread(state)!;
    const last = Date.parse(thread.messages.at(-1)!.created_at) + 1_000;
    const marker: V1MessageRow = {
      info: { id: 'msg_cm', sessionID: ROOT, role: 'user', time: { created: last }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } as unknown as Message,
      parts: [{ id: 'msg_cm-p', sessionID: ROOT, messageID: 'msg_cm', type: 'compaction', auto: false } as unknown as Part],
    };
    const summary: V1MessageRow = {
      info: { id: 'msg_cs', sessionID: ROOT, role: 'assistant', parentID: 'msg_cm', summary: true, time: { created: last, completed: last }, error: { name: 'UnknownError', data: { message: 'Compaction failed' } }, modelID: 'm', providerID: 'p', mode: 'compaction', agent: 'compaction', path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as unknown as Message,
      parts: [],
    };
    const merged = sessionLogThreadWithV1Rows(state, thread, [marker, summary]);
    const added = merged.messages.slice(thread.messages.length);
    const expected = sessionLogOfV1Rows('', ROOT, [marker, summary]).threads[0]!.messages;
    expect(added.map((m) => m.message_id)).toEqual(['msg_cm']);
    expect(added.map(({ seq: _s, ...m }) => m)).toEqual(expected.map(({ seq: _s, ...m }) => m));
  });

  test('identity: the same inputs give the same thread; no extra row gives the thread itself; a changed row renews only its message', () => {
    const state = stateOf(v1Golden);
    const thread = selectSessionLogThread(state)!;
    expect(sessionLogThreadWithV1Rows(state, thread, [])).toBe(thread);
    expect(sessionLogThreadWithV1Rows(state, thread, [optimistic(thread.messages[0]!.message_id, 1, 'held')])).toBe(thread);
    const v1Rows = [optimistic('msg_o1', 1, 'one'), optimistic('msg_o2', 2, 'two')];
    const first = sessionLogThreadWithV1Rows(state, thread, v1Rows);
    expect(sessionLogThreadWithV1Rows(state, thread, v1Rows)).toBe(first);
    const second = sessionLogThreadWithV1Rows(state, thread, [v1Rows[0]!, optimistic('msg_o2', 2, 'two, edited')]);
    expect(second).not.toBe(first);
    expect(second.messages.at(-2)).toBe(first.messages.at(-2)!);
    expect(second.messages.at(-1)).not.toBe(first.messages.at(-1)!);
    expect(second.messages.at(-1)!.blocks).toEqual([{ type: 'text', id: 'msg_o2-p', text: 'two, edited' }]);
  });
});

describe('sessionLogOfV1Rows: the session log of one runtime session\'s v1 store rows (v2 not negotiated)', () => {
  const v1 = toV1(v1Golden);
  const RS = v1.root_id!;
  const T = 1_800_000_000_000;
  // A turn that runs: a running bash and a pending write, no completion.
  const live: V1MessageRow = {
    info: { id: 'msg_zlive', sessionID: RS, role: 'assistant', time: { created: T }, parentID: 'msg_x', modelID: 'm', providerID: 'p', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as unknown as Message,
    parts: [
      { id: 'prt_zlive1', sessionID: RS, messageID: 'msg_zlive', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running', input: { command: 'sleep 5' }, title: 'sleep', metadata: { output: '' }, time: { start: T + 1 } } },
      { id: 'prt_zlive2', sessionID: RS, messageID: 'msg_zlive', type: 'tool', callID: 'call_2', tool: 'write', state: { status: 'pending', input: {}, raw: '' } },
    ] as unknown as Part[],
  };
  const rows = [...rowsOfV1({ ...v1, rows: v1.rows.filter((r) => r.runtime_session_id === RS) }), live];
  const expected = (input: V1MessageRow[]) =>
    fromV1({ session_id: 'kses_v1', root_id: RS, rows: input.map((r) => ({ runtime_session_id: RS, info: r.info as never, parts: r.parts as never })) }, { live: true });

  test('equals fromV1 (live) of the same rows, compaction summaries folded, in any input order', () => {
    expect(rows.some((r) => (r.info as { summary?: boolean }).summary)).toBe(true);
    expect(sessionLogOfV1Rows('kses_v1', RS, rows)).toEqual(expected(rows));
    expect(sessionLogOfV1Rows('kses_v1', RS, [...rows].reverse())).toEqual(expected(rows));
    expect(sessionLogOfV1Rows('kses_v1', RS, [])).toEqual(expected([]));
  });

  test('an optimistic send (a v1 row the store appended) is the last message: a complete user turn with its text', () => {
    const sent: V1MessageRow = {
      info: { id: 'msg_zzopt', sessionID: RS, role: 'user', time: { created: T + 5_000 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } as unknown as Message,
      parts: [{ id: 'prt_zzopt', sessionID: RS, messageID: 'msg_zzopt', type: 'text', text: 'next question' } as unknown as Part],
    };
    const view = sessionLogOfV1Rows('kses_v1', RS, [...rows, sent]).threads[0]!;
    expect(view.messages.at(-1)).toMatchObject({ message_id: 'msg_zzopt', role: 'user', kind: 'turn', status: 'complete', in_context: true, blocks: [{ type: 'text', id: 'prt_zzopt', text: 'next question' }] });
  });

  test('an open call stays open: the live turn is streaming, not closed by the closure rule', () => {
    const message = sessionLogOfV1Rows('kses_v1', RS, rows).threads[0]!.messages.at(-1)!;
    expect(message).toMatchObject({ message_id: 'msg_zlive', status: 'streaming' });
    expect(message.blocks.map((b) => (b as { status?: string }).status)).toEqual(['running', 'pending']);
  });

  test('a changed row keeps the block of every part object it still holds (a text delta does not replace its tool calls)', () => {
    const first = sessionLogOfV1Rows('kses_v1', RS, rows).threads[0]!.messages.at(-1)!;
    // A text part streams in: a new row object, the same two tool part objects.
    const text = { id: 'prt_zlive3', sessionID: RS, messageID: 'msg_zlive', type: 'text', text: 'hel' } as unknown as Part;
    const grown: V1MessageRow = { ...live, parts: [...live.parts, text] };
    const second = sessionLogOfV1Rows('kses_v1', RS, [...rows.slice(0, -1), grown]).threads[0]!.messages.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(second.blocks[1]).toBe(first.blocks[1]);
    // A changed part gets a new block, and the view still equals fromV1 (live).
    const more: V1MessageRow = { ...grown, parts: [live.parts[0]!, { ...live.parts[1]!, state: { status: 'running', input: { filePath: '/w/b' }, time: { start: T + 3 } } } as unknown as Part, { ...text, text: 'hello' } as Part] };
    const input = [...rows.slice(0, -1), more];
    const third = sessionLogOfV1Rows('kses_v1', RS, input);
    const last = third.threads[0]!.messages.at(-1)!;
    expect(last.blocks[0]).toBe(first.blocks[0]);
    expect(last.blocks[1]).not.toBe(first.blocks[1]);
    expect(third).toEqual(expected(input));
  });

  test('restore_grade and grade_counts count only in-context messages, as fromV1 does', () => {
    // A failed attempt (an errored reply, out of context) whose call lost its input: the model never saw it.
    const failed: V1MessageRow = {
      info: { ...(live.info as object), id: 'msg_zfail', time: { created: T + 10, completed: T + 11 }, error: { name: 'APIError', data: { message: 'upstream 500' } } } as unknown as Message,
      parts: [{ id: 'prt_zfail1', sessionID: RS, messageID: 'msg_zfail', type: 'tool', callID: 'call_f', tool: 'bash', state: { status: 'completed', output: 'ok', title: '', metadata: {}, time: { start: T + 10, end: T + 11 } } }] as unknown as Part[],
    };
    const input = [...rows, failed];
    const want = expected(input);
    const message = want.threads[0]!.messages.at(-1)!;
    expect(message).toMatchObject({ message_id: 'msg_zfail', in_context: false, hidden_reason: 'failed_attempt' });
    const got = sessionLogOfV1Rows('kses_v1', RS, input);
    expect(got.grade_counts).toEqual(want.grade_counts!);
    expect(got.restore_grade).toBe(want.restore_grade);
  });

  test('the same rows array gives the same log; a changed row gives a new message for that row only', () => {
    const first = sessionLogOfV1Rows('kses_v1', RS, rows);
    expect(sessionLogOfV1Rows('kses_v1', RS, rows)).toBe(first);
    const changed: V1MessageRow = { ...live, parts: [live.parts[0]!, { ...live.parts[1]!, state: { status: 'running', input: { filePath: '/w/a' }, time: { start: T + 2 } } } as unknown as Part] };
    const next = sessionLogOfV1Rows('kses_v1', RS, [...rows.slice(0, -1), changed]);
    expect(next).not.toBe(first);
    const [a, b] = [first.threads[0]!.messages, next.threads[0]!.messages];
    expect(b.slice(0, -1).every((m, i) => m === a[i])).toBe(true);
    expect(b.at(-1)).not.toBe(a.at(-1));
    expect(next).toEqual(expected([...rows.slice(0, -1), changed]));
  });
});
