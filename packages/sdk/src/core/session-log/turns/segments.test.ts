/**
 * Segments, the work split and burst steps over blocks, on native records (no v1 residuals).
 * `oracle.test.ts` holds the equivalence with `segmentTurn`/`groupShowSegments`/
 * `splitTurnWork`/`mergeBurstSteps` on v1 rows.
 */
import { describe, expect, test } from 'bun:test';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLogBlock, type SessionLogMessage, type SessionLogThread, type ToolCallBlock } from '../types';
import { sessionLogTurns, sessionLogBurstSteps, sessionLogTurnSegments, splitSessionLogTurnWork } from './index';

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
