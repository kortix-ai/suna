import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, Part } from '../runtime/runtime-types';
import { EMPTY_SESSION_LOG_STATE, applySessionLogEvent, applySessionLogPage, type SessionLogState } from './store';
import type { SessionLog } from './types';
import { fromV1, toV1, type V1Transcript } from './v1';
import { sessionLogRowsFor, type V1MessageRow } from './v1-view';

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
    test(`${name}: a thread without the kortix.transcript.v1 ext keeps the v1 store rows (as the API's v1 reads do)`, () => {
      const logs = { kses_1: stateOf(native) };
      const v1Rows: V1MessageRow[] = [];
      for (const thread of native.threads) expect(sessionLogRowsFor(logs, thread.thread_id, v1Rows)).toBe(v1Rows);
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
