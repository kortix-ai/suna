/**
 * Segments, the work split and burst steps over blocks, on native records (no v1 residuals).
 * `oracle.test.ts` holds the equivalence with `segmentTurn`/`groupShowSegments`/
 * `splitTurnWork`/`mergeBurstSteps` on v1 rows.
 */
import { describe, expect, test } from 'bun:test';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLogBlock, type SessionLogMessage, type SessionLogThread, type ToolCallBlock } from '../types';
import { classifyTurn, toToolView } from '../../turns/classify';
import { sessionLogOfV1Rows } from '../v1-view';
import {
  classifySessionLogMessage,
  sessionLogAnsweredQuestionCall,
  sessionLogBurstRunning,
  sessionLogBurstSteps,
  sessionLogBurstSummary,
  sessionLogBurstWorkLabel,
  sessionLogOpenCall,
  sessionLogShowGroupCall,
  sessionLogTurnSegments,
  sessionLogTurns,
  splitSessionLogTurnWork,
} from './index';

const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
let seq = 0;
function msg(id: string, role: 'user' | 'assistant', blocks: SessionLogBlock[], over: Partial<SessionLogMessage> = {}): SessionLogMessage {
  seq += 1;
  return {
    ...V, message_id: id, thread_id: 't', seq, role, kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
    finish: null, error: null, created_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), completed_at: null,
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks, ...over,
  };
}
const call = (id: string, name: string, input: unknown = {}, over: Partial<ToolCallBlock> = {}): ToolCallBlock => ({
  type: 'tool_call', id, call_id: `call_${id}`, name, kind: 'other', input, status: 'complete',
  result: { content: [{ type: 'text', text: 'ok' }], is_error: false }, ...over,
});
const thread = (messages: SessionLogMessage[]): SessionLogThread => ({
  ...V, thread_id: 't', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages,
});
function turnOf(blocks: SessionLogBlock[], over: Partial<SessionLogMessage> = {}) {
  return sessionLogTurns(thread([msg('u', 'user', [{ type: 'text', id: 'q', text: 'go' }]), msg('a', 'assistant', blocks, { reply_to: 'u', ...over })]))[0]!;
}
const shape = (segments: ReturnType<typeof sessionLogTurnSegments>) =>
  segments.map((s) => (s.kind === 'burst' || s.kind === 'show-group' ? [s.kind, s.blocks.map((b) => b.id)] : [s.kind, [s.block.id]]));

describe('sessionLogTurnSegments', () => {
  test('text closes a burst; show and sub-agent calls stand alone; adjacent shows group; bookkeeping renders nothing', () => {
    const turn = turnOf([
      { type: 'step', id: 's0', phase: 'start' },
      { type: 'reasoning', id: 'r1', text: 'think' },
      call('read1', 'read', { path: '/a' }),
      { type: 'harness', id: 'snap', harness: 'opencode', kind: 'snapshot', data: {}, model_visible: false },
      call('read2', 'read', { path: '/b' }),
      { type: 'text', id: 'blank', text: '  ' },
      { type: 'text', id: 't1', text: 'Found it.' },
      call('show1', 'show', { type: 'image', path: '/1.png' }),
      call('show2', 'show', { type: 'image', path: '/2.png' }),
      call('empty', 'show', {}),
      call('agent', 'agent_spawn', { prompt: 'x' }),
      { type: 'step', id: 's1', phase: 'finish' },
      { type: 'text', id: 't2', text: 'Done.' },
    ]);
    expect(shape(sessionLogTurnSegments(turn.blocks))).toEqual([
      ['burst', ['r1', 'read1', 'read2']],
      ['text', ['t1']],
      ['show-group', ['show1', 'show2']],
      ['standalone', ['agent']],
      ['text', ['t2']],
    ]);
    expect(shape(sessionLogTurnSegments(turn.blocks, { standaloneCallIds: new Set(['call_read2', 'call_show2']) }))).toEqual([
      ['burst', ['r1', 'read1']],
      ['standalone', ['read2']],
      ['text', ['t1']],
      ['standalone', ['show1']],
      ['standalone', ['show2']],
      ['standalone', ['agent']],
      ['text', ['t2']],
    ]);
  });

  test('splitSessionLogTurnWork folds the work of a settled turn and keeps deliverables and the final text open', () => {
    const turn = turnOf([call('read1', 'read'), { type: 'text', id: 't1', text: 'mid' }, call('show1', 'show', { type: 'image', path: '/1.png' }), { type: 'text', id: 't2', text: 'Final.' }]);
    const segments = sessionLogTurnSegments(turn.blocks);
    expect(splitSessionLogTurnWork(segments, { working: true })).toBeNull();
    const split = splitSessionLogTurnWork(segments, { working: false })!;
    expect([split.work, split.hoisted, split.final].map(shape)).toEqual([
      [['burst', ['read1']], ['text', ['t1']]],
      [['standalone', ['show1']]],
      [['text', ['t2']]],
    ]);
  });

  test('a block the host made (not from a grouped turn) still segments', () => {
    const own = call('own', 'read', { path: '/c' });
    expect(shape(sessionLogTurnSegments([own]))).toEqual([['burst', ['own']]]);
  });
});

describe('sessionLogBurstSteps', () => {
  test('a run of thoughts is one row; same-family calls group; plumbing never shows', () => {
    const turn = turnOf([
      { type: 'reasoning', id: 'r1', text: 'one' },
      { type: 'reasoning', id: 'r2', text: 'two' },
      call('mem', 'memory_search', { query: 'x' }),
      call('b1', 'bash', { command: 'ls' }, { kind: 'shell' }),
      call('b2', 'bash', { command: 'pwd' }, { kind: 'shell' }),
      call('rd', 'read', { filePath: '/a' }, { kind: 'read' }),
    ]);
    const steps = sessionLogBurstSteps(turn.blocks);
    expect(steps.map((s) => (s.kind === 'thought' ? [s.kind, s.texts, s.running] : s.kind === 'group' ? [s.kind, s.blocks.map((b) => b.id), s.family] : [s.kind, s.block.id]))).toEqual([
      ['thought', ['one', 'two'], false],
      ['group', ['b1', 'b2'], 'run'],
      ['block', 'rd'],
    ]);
  });

  test('a native thought runs only while its message streams and nothing follows it', () => {
    const thinking = turnOf([{ type: 'reasoning', id: 'r1', text: 'hmm' }], { status: 'streaming' });
    expect(sessionLogBurstSteps(thinking.blocks)).toMatchObject([{ kind: 'thought', running: true }]);
    const settled = turnOf([{ type: 'reasoning', id: 'r1', text: 'hmm' }], { status: 'complete' });
    expect(sessionLogBurstSteps(settled.blocks)).toMatchObject([{ kind: 'thought', running: false }]);
  });

  test('an answered question is its own row, never inside a group', () => {
    const question = (id: string) =>
      call(id, 'question', { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] }, { kind: 'question', result: { content: [{ type: 'text', text: 'User has answered your questions: "Which?"="A".' }], is_error: false } });
    const steps = sessionLogBurstSteps(turnOf([question('q1'), question('q2')]).blocks);
    expect(steps.map((s) => s.kind)).toEqual(['block', 'block']);
  });
});

describe('sessionLogBurstSummary / sessionLogBurstRunning', () => {
  test('the summary counts what the chain renders: one thought run, each call; plumbing only flags', () => {
    const turn = turnOf([
      { type: 'reasoning', id: 'r1', text: 'one' },
      { type: 'reasoning', id: 'r2', text: 'two' },
      call('mem', 'memory_search', { query: 'x' }),
      call('b1', 'bash', { command: 'ls' }, { kind: 'shell' }),
      call('b2', 'bash', { command: 'false' }, { kind: 'shell', status: 'error', result: { content: [{ type: 'text', text: 'exit 1' }], is_error: true, error: { message: 'exit 1' } } }),
    ]);
    expect(sessionLogBurstSummary(turn.blocks)).toEqual({ total: 3, failed: 1, completed: 2, hasPlumbing: true });
  });

  test('the work label names the calls and the failures, never the thinking or the plumbing', () => {
    const turn = turnOf([
      { type: 'reasoning', id: 'r1', text: 'one' },
      call('mem', 'memory_search', { query: 'x' }),
      call('b1', 'bash', { command: 'ls' }, { kind: 'shell' }),
      call('b2', 'bash', { command: 'false' }, { kind: 'shell', status: 'error', result: { content: [{ type: 'text', text: 'exit 1' }], is_error: true, error: { message: 'exit 1' } } }),
    ]);
    expect(sessionLogBurstWorkLabel(turn.blocks)).toBe('Ran 2 commands · 1 failed');
  });

  test('a burst runs while the turn works: the trailing one always, another while a call is open or a thought streams', () => {
    const running = turnOf([call('b1', 'bash', { command: 'make' }, { status: 'running', result: undefined })], { status: 'streaming' });
    expect(sessionLogBurstRunning(running.blocks, { working: false })).toBe(false);
    expect(sessionLogBurstRunning(running.blocks, { working: true })).toBe(true);
    const settled = turnOf([call('b1', 'bash', { command: 'ls' })], { status: 'streaming' });
    expect(sessionLogBurstRunning(settled.blocks, { working: true })).toBe(false);
    expect(sessionLogBurstRunning(settled.blocks, { working: true, trailing: true })).toBe(true);
    const thinking = turnOf([{ type: 'reasoning', id: 'r1', text: 'hmm' }], { status: 'streaming' });
    expect(sessionLogBurstRunning(thinking.blocks, { working: true })).toBe(true);
    const thought = turnOf([{ type: 'reasoning', id: 'r1', text: 'hmm' }], { status: 'complete' });
    expect(sessionLogBurstRunning(thought.blocks, { working: true })).toBe(false);
  });

  test('a v1 thought with an end time is done, whatever its message says', () => {
    const rows = [
      { info: { id: 'msg_u', sessionID: 'ses', role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_q', sessionID: 'ses', messageID: 'msg_u', type: 'text', text: 'go' }] },
      {
        info: { id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_u', time: { created: 2 } },
        parts: [{ id: 'prt_r', sessionID: 'ses', messageID: 'msg_a', type: 'reasoning', text: 'hmm', time: { start: 2, end: 3 } }],
      },
    ];
    const [turn] = sessionLogTurns(sessionLogOfV1Rows('kses', 'ses', rows as never).threads[0]!);
    expect(turn!.assistant[0]!.status).toBe('streaming');
    expect(sessionLogBurstRunning(turn!.blocks, { working: true })).toBe(false);
  });
});

describe('sessionLogOpenCall', () => {
  test('a call the closure rule closed reads open (running once started, else pending, no result); every other call is itself', () => {
    const closed = (over: Partial<ToolCallBlock>) =>
      call('c', 'bash', { command: 'sleep 9' }, { status: 'error', result: { content: [{ type: 'text', text: '[interrupted]' }], is_error: true, synthetic: true, error: { code: 'interrupted', message: '[interrupted]' } }, ...over });
    const started = closed({ started_at: '2026-10-01T00:00:00.000Z' });
    const open = sessionLogOpenCall(started);
    expect(open).toMatchObject({ status: 'running', call_id: 'call_c', input: { command: 'sleep 9' } });
    expect(open.result).toBeUndefined();
    expect(sessionLogOpenCall(started)).toBe(open);
    expect(sessionLogOpenCall(closed({})).status).toBe('pending');
    const failed = call('f', 'bash', {}, { status: 'error', result: { content: [{ type: 'text', text: 'exit 1' }], is_error: true } });
    expect(sessionLogOpenCall(failed)).toBe(failed);
    const done = call('d', 'bash');
    expect(sessionLogOpenCall(done)).toBe(done);
  });
});

describe('sessionLogShowGroupCall', () => {
  test('adjacent show calls become one call of the first id whose input is the items carousel', () => {
    const one = call('show1', 'show', { type: 'image', path: '/1.png' });
    const two = call('show2', 'show', { type: 'image', path: '/2.png' });
    const merged = sessionLogShowGroupCall([one, two]);
    expect(merged).toMatchObject({ id: 'show1', call_id: 'call_show1', name: 'show', status: 'complete' });
    expect((merged.input as { items: unknown[] }).items).toEqual([
      { status: 'ready', type: 'image', path: '/1.png' },
      { status: 'ready', type: 'image', path: '/2.png' },
    ]);
    const live = sessionLogShowGroupCall([one, call('show3', 'show', { type: 'image', path: '/3.png' }, { status: 'running', result: undefined })]);
    expect(live.status).toBe('running');
    const failed = sessionLogShowGroupCall([one, call('show4', 'show', { title: 'Chart' }, { status: 'error', result: { content: [{ type: 'text', text: 'gone' }], is_error: true, error: { message: 'gone' } } })]);
    expect((failed.input as { items: unknown[] }).items.at(-1)).toEqual({ status: 'error', type: 'error', title: 'Chart', content: 'gone' });
  });
});

describe('sessionLogAnsweredQuestionCall', () => {
  test('the question call with the answers the user gave, before the harness confirms them', () => {
    const asked = call('q', 'question', { questions: [{ question: 'Which?' }] }, { kind: 'question', status: 'running', result: undefined });
    const answered = sessionLogAnsweredQuestionCall(asked, [['A']]);
    expect(answered).toMatchObject({ id: 'q', call_id: 'call_q', status: 'complete', input: { questions: [{ question: 'Which?' }] } });
    expect(toToolView(answered).answers).toEqual([['A']]);
    const withInput = sessionLogAnsweredQuestionCall(asked, [['B']], { questions: [{ question: 'Other?' }] });
    expect(withInput.input).toEqual({ questions: [{ question: 'Other?' }] });
  });
});

describe('classifySessionLogMessage', () => {
  const at = 1_790_000_000_000;
  const v1User = { info: { id: 'msg_u', sessionID: 'ses_r', role: 'user', time: { created: at }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' } }, parts: [{ id: 'prt_u', sessionID: 'ses_r', messageID: 'msg_u', type: 'text', text: 'go' }] };
  const v1Reply = (over: Record<string, unknown> = {}, parts: Array<Record<string, unknown>> = []) => ({
    info: { id: 'msg_a', sessionID: 'ses_r', role: 'assistant', parentID: 'msg_u', time: { created: at + 1, completed: at + 2 }, providerID: 'kortix', modelID: 'm', mode: 'build', agent: 'build', path: { cwd: '/w', root: '/w' }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...over },
    parts: parts.map((p, i) => ({ id: `prt_${i}`, sessionID: 'ses_r', messageID: 'msg_a', ...p })),
  });
  const convert = (rows: unknown[]) => sessionLogOfV1Rows('S', 'ses_r', rows as never).threads[0]!.messages;

  test('a converted reply classifies exactly as classifyTurn classified its v1 row', () => {
    const row = v1Reply({}, [
      { type: 'step-start' },
      { type: 'reasoning', text: 'think', time: { start: at, end: at + 1 } },
      { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', title: 'ls', metadata: {}, time: { start: at, end: at + 1 } } },
      { type: 'text', text: 'Done.' },
      { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'kortix-attachment://P/S/att_1' },
      { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    ]);
    const [, reply] = convert([v1User, row]);
    expect(classifySessionLogMessage(reply!)).toEqual(classifyTurn(row as never));
  });

  test("a failed reply keeps the gateway's own sentence, which the record's error.message does not carry", () => {
    const error = { name: 'APIError', data: { message: 'Bad Request', statusCode: 402, isRetryable: false, responseBody: '{"error":"plan_upgrade_required","code":402,"message":"Pick a free model.","provider":"kortix","suggestion":"Upgrade your plan."}' } };
    const [, reply] = convert([v1User, v1Reply({ error })]);
    expect(reply!.error?.message).toBe('Bad Request');
    expect(classifySessionLogMessage(reply!).error).toMatchObject({ name: 'APIError', message: 'Pick a free model.' });
  });

  test('a compaction is one message: the marker part, then the summary text', () => {
    const marker = { info: { ...v1User.info, id: 'msg_c' }, parts: [{ id: 'prt_c', sessionID: 'ses_r', messageID: 'msg_c', type: 'compaction', auto: false }] };
    const summary = v1Reply({ id: 'msg_s', parentID: 'msg_c', mode: 'compaction', agent: 'compaction', summary: true }, [{ type: 'text', text: 'SUMMARY' }]);
    const [message] = convert([marker, summary]);
    expect(message!.kind).toBe('compaction');
    expect(classifySessionLogMessage(message!).parts.map((p) => p.kind === 'text' ? ['text', p.text] : [p.kind])).toEqual([['compaction'], ['text', 'SUMMARY']]);
  });

  test('a native record classifies from its blocks: text, a tool call as its tool view, an empty reply is empty', () => {
    const tool = call('c1', 'bash', { command: 'ls' }, { kind: 'shell', result: { content: [{ type: 'text', text: 'a.txt' }], is_error: false } });
    const native = msg('n1', 'assistant', [{ type: 'text', id: 't1', text: 'hi' }, tool], { reply_to: 'u' });
    const classified = classifySessionLogMessage(native);
    expect(classified.parts.map((p) => p.kind)).toEqual(['text', 'tool']);
    expect(classified.parts[1]).toMatchObject({ kind: 'tool', tool: { name: 'bash', status: 'done', output: 'a.txt' } });
    expect(classified.isEmpty).toBe(false);
    expect(classifySessionLogMessage(msg('n2', 'assistant', [])).isEmpty).toBe(true);
  });
});
