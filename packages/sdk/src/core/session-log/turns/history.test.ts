/**
 * P5.6: what a transcript shows about a session's history: a Kortix notice (the D3 restore
 * note), a harness switch, the restore notice of a partial restore, messages out of context
 * hidden on request, and texts the API stored by reference.
 */
import { describe, expect, test } from 'bun:test';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLog, type SessionLogBlock, type SessionLogMessage, type SessionLogThread } from '../types';
import { sessionLogOfV1Rows } from '../v1-view';
import {
  SESSION_LOG_FULL_TEXT_INLINE_MAX_BYTES,
  isSessionLogRestoreNote,
  sessionLogFullTextAction,
  sessionLogFullTextPlan,
  sessionLogHarnessSwitches,
  sessionLogReferencedTexts,
  sessionLogRestoreNotice,
  sessionLogTurns,
  sessionLogWithFullTexts,
} from './index';

const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
const PRODUCER = { harness: 'pi', harness_version: '1', adapter_version: '1' };
let seq = 0;
function msg(id: string, role: 'user' | 'assistant', blocks: SessionLogBlock[], over: Partial<SessionLogMessage> = {}): SessionLogMessage {
  seq += 1;
  return {
    ...V, message_id: id, thread_id: 't', seq, role, kind: 'turn', status: 'complete', in_context: true,
    model: null, usage: null, finish: role === 'assistant' ? 'stop' : null, error: null,
    created_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), completed_at: null, producer: PRODUCER, blocks, ...over,
  };
}
const user = (id: string, over: Partial<SessionLogMessage> = {}) => msg(id, 'user', [{ type: 'text', id: `${id}-t`, text: id }], over);
const reply = (id: string, to: string, over: Partial<SessionLogMessage> = {}) => msg(id, 'assistant', [{ type: 'text', id: `${id}-t`, text: 'ok' }], { reply_to: to, ...over });
const thread = (messages: SessionLogMessage[]): SessionLogThread => ({
  ...V, thread_id: 't', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages,
});
const note = (id: string, generation = 2, over: Partial<SessionLogMessage> = {}) =>
  msg(id, 'user', [{ type: 'text', id: `prt_kortix_restore_g${generation}`, text: 'Kortix: this session was restored from its saved session log.' }], {
    origin: 'notification', producer: { harness: 'kortix', harness_version: 'restore', adapter_version: '1' }, ...over,
  });

describe('isSessionLogRestoreNote', () => {
  test('the restore note is found by its block id, with its origin (v2) and without it (the v1 fallback has no origin)', () => {
    expect(isSessionLogRestoreNote(note('n1'))).toBe(true);
    const { origin: _, ...v1Shape } = note('n2');
    expect(isSessionLogRestoreNote(v1Shape)).toBe(true);
  });

  test('another notification (a sub-agent completion), a prompt and a reply are not', () => {
    expect(isSessionLogRestoreNote(user('n', { origin: 'notification' }))).toBe(false);
    expect(isSessionLogRestoreNote(user('p', { origin: 'prompt' }))).toBe(false);
    expect(isSessionLogRestoreNote(reply('a', 'p', { blocks: [{ type: 'text', id: 'prt_kortix_restore_g1', text: 'x' }] }))).toBe(false);
  });

  test('the fromV1 view of a v1 row keeps the note block id, so the v1 fallback detects it', () => {
    const rows = [{ info: { id: 'msg_note', role: 'user', sessionID: 'ses', time: { created: 1 } }, parts: [{ id: 'prt_kortix_restore_g3', type: 'text', text: 'Kortix: restored.' }] }];
    const m = sessionLogOfV1Rows('ses', 'ses', rows as never).threads[0]!.messages[0]!;
    expect(m.origin).toBeUndefined();
    expect(isSessionLogRestoreNote(m)).toBe(true);
  });

  test('the note is a turn of its own with no reply; the prompt after it is the working turn', () => {
    const turns = sessionLogTurns(thread([user('u1'), reply('a1', 'u1'), note('n'), user('u2')]), { busy: true });
    expect(turns.map((t) => [t.id, t.assistant.length, t.live, t.queued])).toEqual([
      ['u1', 1, false, false],
      ['n', 0, false, false],
      ['u2', 0, true, false],
    ]);
  });
});

describe('hideOutOfContext', () => {
  const failed = (id: string, to: string) => reply(id, to, { status: 'error', in_context: false, hidden_reason: 'failed_attempt', error: { code: 'provider_error', message: 'boom' } });

  test('default: a failed attempt keeps its rows (today’s transcript)', () => {
    const turns = sessionLogTurns(thread([user('u1'), failed('f1', 'u1'), reply('a1', 'u1')]));
    expect(turns[0]!.assistant.map((m) => m.message_id)).toEqual(['f1', 'a1']);
    expect(turns[0]!.error?.code).toBe('provider_error');
  });

  test('on: a message out of context leaves its turn, its error goes with it; a superseded prompt leaves with its turn', () => {
    const turns = sessionLogTurns(
      thread([user('old', { in_context: false, hidden_reason: 'superseded' }), reply('oa', 'old', { in_context: false, hidden_reason: 'superseded' }), user('u1'), failed('f1', 'u1'), reply('a1', 'u1')]),
      { hideOutOfContext: true },
    );
    expect(turns.map((t) => [t.id, t.assistant.map((m) => m.message_id)])).toEqual([['u1', ['a1']]]);
    expect(turns[0]!.error).toBeNull();
  });

  test('on: a streaming message stays (a compaction marker until its summary lands)', () => {
    const marker = msg('c1', 'user', [{ type: 'compaction', id: 'c1-c', summary: null, first_kept_message_id: null }], { kind: 'compaction', status: 'streaming', in_context: false });
    const turns = sessionLogTurns(thread([user('u1'), reply('a1', 'u1'), marker]), { hideOutOfContext: true, busy: true });
    expect(turns.map((t) => t.id)).toEqual(['u1', 'c1']);
  });
});

describe('sessionLogHarnessSwitches', () => {
  const history = (...entries: Array<[string, number]>): SessionLog['harness']['history'] =>
    entries.map(([harness, from_seq], i) => ({ harness, version: `v${i}`, from_seq, at: `2026-10-1${i}T00:00:00.000Z` }));
  const turnsAt = (...seqs: number[]) => seqs.map((s) => ({ id: `u${s}`, user: { seq: s } }));

  test('a switch lands on the first turn at or after its from_seq, naming both harnesses', () => {
    const switches = sessionLogHarnessSwitches(history(['opencode', 1], ['pi', 5]), turnsAt(1, 3, 5, 7));
    expect([...switches]).toEqual([['u5', { harness: 'pi', previous: 'opencode', version: 'v1', at: '2026-10-11T00:00:00.000Z' }]]);
  });

  test('a new version of the same harness is no switch; a switch back is; history order does not matter', () => {
    const switches = sessionLogHarnessSwitches(history(['pi', 9], ['opencode', 1], ['opencode', 3], ['opencode', 6]), turnsAt(1, 2, 4, 6, 8, 10));
    expect([...switches.entries()].map(([id, s]) => [id, s.previous, s.harness])).toEqual([['u10', 'opencode', 'pi']]);
  });

  test('a switch before the first loaded turn is not drawn (older pages hold it); one exactly at it is', () => {
    expect(sessionLogHarnessSwitches(history(['opencode', 1], ['pi', 3]), turnsAt(6, 8)).size).toBe(0);
    expect([...sessionLogHarnessSwitches(history(['opencode', 1], ['pi', 6]), turnsAt(6, 8)).keys()]).toEqual(['u6']);
  });

  test('no history, one entry, or a switch past every turn: none', () => {
    expect(sessionLogHarnessSwitches(undefined, turnsAt(1)).size).toBe(0);
    expect(sessionLogHarnessSwitches(history(['pi', 1]), turnsAt(1, 2)).size).toBe(0);
    expect(sessionLogHarnessSwitches(history(['opencode', 1], ['pi', 9]), turnsAt(1, 2)).size).toBe(0);
  });
});

describe('sessionLogRestoreNotice', () => {
  const restored = (data: unknown, over: Partial<SessionLog> = {}): Partial<SessionLog> => ({
    restore_grade: 'partial',
    grade_counts: { tool_input: 0, cut_point: 1, attachment: 2 },
    ext: { kortix: { version: '1', data: { restore: data } } },
    ...over,
  });

  test('a partial restore names what is missing: the grade counts, the dropped texts and tool results, the truncated texts, other kinds', () => {
    const notice = sessionLogRestoreNotice(restored({ generation: 4, dropped: { attachment: 2, layout: 1, text: 1, tool_result: 1, mystery: 2 }, truncated: 1 }));
    expect(notice).toEqual({
      generation: 4,
      missing: [
        { kind: 'attachment', count: 2 },
        { kind: 'text', count: 2 },
        { kind: 'tool_result', count: 1 },
        { kind: 'cut_point', count: 1 },
        { kind: 'other', count: 2 },
      ],
    });
  });

  test('no notice without a partial grade, or without the restore record (a log converted partial from v1 was never restored)', () => {
    expect(sessionLogRestoreNotice(restored({ generation: 4, dropped: {}, truncated: 0 }, { restore_grade: 'native' }))).toBeNull();
    expect(sessionLogRestoreNotice({ restore_grade: 'partial', grade_counts: { tool_input: 1, cut_point: 0, attachment: 0 } })).toBeNull();
    expect(sessionLogRestoreNotice(null)).toBeNull();
    expect(sessionLogRestoreNotice(restored('not an object'))).toBeNull();
  });

  test('a notice with nothing countable still reads as a restore (the counts are empty)', () => {
    expect(sessionLogRestoreNotice(restored({ generation: 1, dropped: {}, truncated: 0 }, { grade_counts: undefined }))).toEqual({ generation: 1, missing: [] });
  });
});

describe('texts stored by reference', () => {
  const REF = 'kortix-attachment://11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333';
  const big = (id: string) => msg(id, 'user', [{ type: 'text', id: `${id}-t`, text: 'preview', ref: REF, bytes: 300_000 }]);
  const tool = (id: string) =>
    msg(id, 'assistant', [{
      type: 'tool_call', id: `${id}-c`, call_id: 'c', name: 'bash', kind: 'shell', input: {}, status: 'complete',
      result: { content: [{ type: 'text', text: 'head', ref: `${REF}x`, bytes: 400_000 }], is_error: false },
    }], { reply_to: 'u' });

  test('lists every text and tool-result text item with a ref, once per ref', () => {
    expect(sessionLogReferencedTexts([big('u'), tool('a'), big('u2'), user('plain')])).toEqual([
      { ref: REF, bytes: 300_000 },
      { ref: `${REF}x`, bytes: 400_000 },
    ]);
  });

  test('replaces a loaded text and drops its ref; an unloaded one and an untouched message keep their identity', () => {
    const plain = user('plain');
    const t = thread([plain, big('u'), tool('a')]);
    const out = sessionLogWithFullTexts(t, new Map([[REF, 'the whole text']]));
    expect(out.messages[0]).toBe(plain);
    expect(out.messages[1]!.blocks[0]).toEqual({ type: 'text', id: 'u-t', text: 'the whole text' });
    expect(out.messages[2]).toBe(t.messages[2]);
    expect(sessionLogReferencedTexts(out.messages)).toEqual([{ ref: `${REF}x`, bytes: 400_000 }]);
    expect(sessionLogWithFullTexts(t, new Map())).toBe(t);
  });

  test('a tool result text item is replaced where the UI renders it (content); a ref only in model_content is not listed', () => {
    const out = sessionLogWithFullTexts(thread([tool('a')]), new Map([[`${REF}x`, 'all output']]));
    const block = out.messages[0]!.blocks[0]!;
    expect(block.type === 'tool_call' && block.result?.content).toEqual([{ type: 'text', text: 'all output' }]);
    const modelOnly = msg('m', 'assistant', [{
      type: 'tool_call', id: 'm-c', call_id: 'c', name: 'bash', kind: 'shell', input: {}, status: 'complete',
      result: { content: [{ type: 'text', text: 'short' }], model_content: [{ type: 'text', text: 'head', ref: `${REF}m`, bytes: 500_000 }], is_error: false },
    }], { reply_to: 'u' });
    expect(sessionLogReferencedTexts([modelOnly])).toEqual([]);
  });

  test('the same message and the same map give the same object (a streamed frame does not rebuild it)', () => {
    const t = thread([big('u')]);
    const texts = new Map([[REF, 'whole']]);
    expect(sessionLogWithFullTexts(t, texts).messages[0]).toBe(sessionLogWithFullTexts({ ...t }, texts).messages[0]!);
  });
});

describe('sessionLogFullTextAction', () => {
  const ref = (bytes: number) => ({ ref: `r${bytes}`, bytes });
  test('texts up to 1 MB in all are shown inline; above, they are downloaded', () => {
    expect(SESSION_LOG_FULL_TEXT_INLINE_MAX_BYTES).toBe(1024 * 1024);
    expect(sessionLogFullTextAction([ref(300_000)])).toBe('inline');
    expect(sessionLogFullTextAction([ref(1024 * 1024)])).toBe('inline');
    expect(sessionLogFullTextAction([ref(1024 * 1024 + 1)])).toBe('download');
    expect(sessionLogFullTextAction([ref(600_000), ref(600_000)])).toBe('download');
  });
});

describe('sessionLogFullTextPlan', () => {
  const ref = (name: string, bytes: number) => ({ ref: name, bytes });
  test('up to 1 MB in all: every text inline, none downloaded', () => {
    const refs = [ref('a', 300_000), ref('b', 1024 * 1024 - 300_000)];
    expect(sessionLogFullTextPlan(refs)).toEqual({ inline: refs, download: [] });
  });

  test('above 1 MB in all: only the large texts download; the small ones still show inline', () => {
    const big = ref('big', 5_000_000);
    const small = ref('small', 20_000);
    expect(sessionLogFullTextPlan([big, small])).toEqual({ inline: [small], download: [big] });
  });

  test('the smallest texts fill the inline budget first, in record order', () => {
    const [a, b, c] = [ref('a', 600_000), ref('b', 300_000), ref('c', 600_000)];
    expect(sessionLogFullTextPlan([a, b, c])).toEqual({ inline: [a, b], download: [c] });
  });

  test('the plan agrees with the action: a download exactly when the action says so', () => {
    for (const refs of [[ref('a', 1)], [ref('a', 1024 * 1024 + 1)], [ref('a', 600_000), ref('b', 600_000)]]) {
      expect(sessionLogFullTextPlan(refs).download.length > 0).toBe(sessionLogFullTextAction(refs) === 'download');
    }
  });
});
