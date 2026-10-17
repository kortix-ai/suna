/**
 * The block-native rules of `sessionLogTurns`: what a native v2 record (no v1 residuals)
 * gives, and what the schema decides that v1 had to guess. `oracle.test.ts` holds the
 * equivalence with the v1 helpers.
 */
import { describe, expect, test } from 'bun:test';
import type { SessionPrompt } from '../../rest/projects-client/sessions';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLogBlock, type SessionLogMessage, type SessionLogThread, type ToolCallBlock } from '../types';
import { COST_MARKUP } from '../../turns';
import { sessionLogOfV1Rows } from '../v1-view';
import { sessionLogTurns, sessionLogCallStatus, sessionLogPromptMessage, sessionLogRetrying } from './index';

const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
const PRODUCER = { harness: 'pi', harness_version: '1', adapter_version: '1' };
let seq = 0;
function msg(id: string, role: 'user' | 'assistant' | 'system', blocks: SessionLogBlock[], over: Partial<SessionLogMessage> = {}): SessionLogMessage {
  seq += 1;
  return {
    ...V, message_id: id, thread_id: 't', seq, role, kind: 'turn', status: 'complete', in_context: true,
    model: { provider: 'kortix', model: 'm' }, usage: role === 'assistant' ? { input: 10, output: 2, cache_read: 0, cache_write: 0, cost: 0.01 } : null,
    finish: role === 'assistant' ? 'stop' : null, error: null, created_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    completed_at: null, producer: PRODUCER, blocks, ...over,
  };
}
const user = (id: string, t = id, over: Partial<SessionLogMessage> = {}) => msg(id, 'user', [{ type: 'text', id: `${id}-t`, text: t }], over);
const reply = (id: string, to: string | null, blocks: SessionLogBlock[] = [{ type: 'text', id: `${id}-t`, text: 'ok' }], over: Partial<SessionLogMessage> = {}) =>
  msg(id, 'assistant', blocks, { reply_to: to, ...over });
const call = (id: string, name: string, over: Partial<ToolCallBlock> = {}): ToolCallBlock => ({
  type: 'tool_call', id, call_id: `call_${id}`, name, kind: 'other', input: {}, status: 'complete',
  result: { content: [{ type: 'text', text: 'done' }], is_error: false }, ...over,
});
const thread = (messages: SessionLogMessage[], over: Partial<SessionLogThread> = {}): SessionLogThread => ({
  ...V, thread_id: 't', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages, ...over,
});

describe('grouping', () => {
  test('a reply joins the prompt it names, then the latest prompt; a reply with no loaded prompt opens a partial turn', () => {
    const turns = sessionLogTurns(thread([
      reply('early', 'gone'),
      user('u1'),
      reply('a1', 'u1'),
      user('u2'),
      reply('a2', null),
      reply('late', 'u1'),
    ]));
    expect(turns.map((t) => [t.id, t.partial, t.assistant.map((m) => m.message_id)])).toEqual([
      ['gone', true, ['early']],
      ['u1', false, ['a1', 'late']],
      ['u2', false, ['a2']],
    ]);
    expect(turns[0]!.user).toMatchObject({ message_id: 'gone', role: 'user', blocks: [] });
  });

  test('a message out of context stays (a failed attempt keeps its rows); system and context messages are not turns', () => {
    const turns = sessionLogTurns(thread([
      msg('sys', 'system', [{ type: 'text', id: 's', text: 'rules' }]),
      user('u1'),
      reply('fail', 'u1', undefined, { status: 'error', in_context: false, hidden_reason: 'failed_attempt', error: { code: 'provider_error', message: 'boom' } }),
      msg('ctx', 'user', [{ type: 'text', id: 'c', text: 'AGENTS.md' }], { kind: 'context' }),
      reply('ok', 'u1'),
    ]));
    expect(turns.map((t) => [t.id, t.assistant.map((m) => m.message_id)])).toEqual([['u1', ['fail', 'ok']]]);
  });

  test('a reply shell with no blocks, no error and zero usage is not drawn', () => {
    const turns = sessionLogTurns(thread([user('u1'), reply('shell', 'u1', [], { usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } })]));
    expect(turns[0]!.assistant).toEqual([]);
  });

  test('held prompts go after the thread, in the order given, and the agent is not on them', () => {
    const turns = sessionLogTurns(thread([user('q2'), user('u1'), reply('a1', 'u1', undefined, { status: 'streaming' }), user('q1')]), {
      busy: true,
      held: ['q1', 'q2'],
    });
    expect(turns.map((t) => [t.id, t.live, t.queued])).toEqual([
      ['u1', true, false],
      ['q1', false, true],
      ['q2', false, true],
    ]);
  });

  test('sessionLogPromptMessage is the user message of an inbox prompt the transcript has not placed', () => {
    const prompt = { prompt_id: 'p9', message_id: null, text: 'short', full_text: 'the full prompt', client_sent_at_ms: 1_700_000_100_000, created_at: '2023-11-14T22:13:20.000Z' } as unknown as SessionPrompt;
    const m = sessionLogPromptMessage(prompt, 't');
    expect(m).toMatchObject({ message_id: 'queued-p9', thread_id: 't', role: 'user', kind: 'turn', status: 'complete', created_at: new Date(1_700_000_100_000).toISOString() });
    expect(m.blocks).toEqual([{ type: 'text', id: 'syn-p9', text: 'the full prompt' }]);
    const [turn] = sessionLogTurns(thread([m]), { held: ['queued-p9'] });
    expect([turn!.id, turn!.queued, turn!.status]).toEqual(['queued-p9', true, 'pending']);
  });

  test('turns keep their identity while their messages do; a changed message renews only its turn', () => {
    const messages = [user('u1'), reply('a1', 'u1'), user('u2'), reply('a2', 'u2')];
    const first = sessionLogTurns(thread(messages));
    const again = sessionLogTurns(thread([...messages]));
    expect(again[0]).toBe(first[0]!);
    expect(again[1]).toBe(first[1]!);
    const next = sessionLogTurns(thread([...messages.slice(0, 3), { ...messages[3]!, blocks: [{ type: 'text', id: 'x', text: 'more' }] }]));
    expect(next[0]).toBe(first[0]!);
    expect(next[1]).not.toBe(first[1]!);
  });
});

describe('derived fields', () => {
  test('status: pending before a reply, then the last reply status; a retrying reply is streaming', () => {
    const turns = sessionLogTurns(thread([
      user('u1'), reply('a1', 'u1', undefined, { status: 'aborted', finish: 'aborted', error: { code: 'aborted', message: 'stopped' } }),
      user('u2'), reply('a2', 'u2', undefined, { status: 'interrupted' }),
      user('u3'),
    ]));
    expect(turns.map((t) => t.status)).toEqual(['aborted', 'interrupted', 'pending']);
  });

  test('error: the first errored reply; the code is the schema code and the message the sentence of a gateway body', () => {
    const body = JSON.stringify({ error: { message: 'Your key is invalid.', provider: 'acme', code: 'auth', request_id: 'req_9' } });
    const [turn] = sessionLogTurns(thread([
      user('u1'),
      reply('a1', 'u1', undefined, { status: 'error', in_context: false, error: { code: 'auth_error', message: body } }),
      reply('a2', 'u1', undefined, { status: 'error', error: { code: 'unknown', message: 'later' } }),
    ]));
    expect(turn!.error).toMatchObject({ code: 'auth_error', message: 'Your key is invalid.', details: { provider: 'acme', code: 'auth', requestId: 'req_9' } });
    expect(turn!.error!.raw).toBe(body);
  });

  test('cost: usage summed over the replies, with the platform markup; subscription models cost nothing; a lookup prices a reply that reports no cost', () => {
    const [turn] = sessionLogTurns(thread([
      user('u1'),
      reply('a1', 'u1', undefined, { usage: { input: 100, output: 10, cache_read: 5, cache_write: 1, reasoning: 2, cost: 0.5 } }),
      reply('a2', 'u1', undefined, { usage: { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 } }),
      reply('a3', 'u1', undefined, { model: { provider: 'codex', model: 'gpt' }, usage: { input: 7, output: 7, cache_read: 0, cache_write: 0, cost: 9 } }),
    ]), { pricing: (provider) => (provider === 'kortix' ? { inputPer1M: 2, outputPer1M: 4 } : null) });
    expect(turn!.cost!.cost).toBeCloseTo((0.5 + 2) * COST_MARKUP, 9);
    expect(turn!.cost!.tokens).toEqual({ input: 1_000_107, output: 17, reasoning: 2, cacheRead: 5, cacheWrite: 1 });
    const [none] = sessionLogTurns(thread([user('u9')]));
    expect(none!.cost).toBeNull();
  });

  test('compaction: the marker message is the turn, its block and state are derived once', () => {
    const block = { type: 'compaction' as const, id: 'c1', summary: 'SUMMARY', first_kept_message_id: 'u1', trigger: 'auto' as const };
    const turns = sessionLogTurns(thread([
      user('u1'),
      msg('cmp', 'user', [block], { kind: 'compaction', status: 'complete' }),
      msg('cmp2', 'user', [{ ...block, id: 'c2', summary: null }], { kind: 'compaction', status: 'streaming' }),
      msg('cmp3', 'user', [{ ...block, id: 'c3', summary: null }], { kind: 'compaction', status: 'error', in_context: false, error: { code: 'context_overflow', message: 'too long' } }),
    ]));
    expect(turns.map((t) => t.compaction && { ...t.compaction, block: t.compaction.block?.id })).toEqual([
      null,
      { block: 'c1', hasContent: true, inFlight: false },
      { block: 'c2', hasContent: false, inFlight: true },
      { block: 'c3', hasContent: false, inFlight: false },
    ]);
    expect(turns[3]!.error).toMatchObject({ code: 'context_overflow', message: 'too long' });
  });

  test('a compaction inside a turn: the replies after it continue below the marker, not above it', () => {
    // pi compacts mid-turn and keeps naming the prompt (`reply_to: u1`); OpenCode would send a
    // synthetic continue prompt. The work after the marker is a continuation turn: a stand-in
    // prompt with no blocks (no bubble), and the live turn when the working turn names u1.
    const block = { type: 'compaction' as const, id: 'c1', summary: 'SUMMARY', first_kept_message_id: 'a1', trigger: 'auto' as const };
    const messages = [
      user('u1'),
      reply('a1', 'u1'),
      msg('cmp', 'user', [block], { kind: 'compaction', status: 'complete' }),
      reply('a2', 'u1'),
      reply('a3', null),
      msg('cmp2', 'user', [{ ...block, id: 'c2' }], { kind: 'compaction', status: 'complete' }),
      reply('a4', 'u1', undefined, { status: 'streaming' }),
    ];
    const turns = sessionLogTurns(thread(messages), { busy: true, liveMessageId: 'u1' });
    expect(turns.map((t) => [t.id, t.partial, t.compaction !== null, t.assistant.map((m) => m.message_id), t.live])).toEqual([
      ['u1', false, false, ['a1'], false],
      ['cmp', false, true, [], false],
      ['cmp:continued', true, false, ['a2', 'a3'], false],
      ['cmp2', false, true, [], false],
      ['cmp2:continued', true, false, ['a4'], true],
    ]);
    expect(turns[2]!.user).toMatchObject({ message_id: 'cmp:continued', role: 'user', kind: 'turn', blocks: [], created_at: messages[2]!.created_at });
    expect(turns.map((t) => t.continues)).toEqual([null, null, { marker: 'cmp', prompt: 'u1' }, null, { marker: 'cmp2', prompt: 'u1' }]);
    // The working turn named by the marker is its continuation too; the identity holds across reads.
    const again = sessionLogTurns(thread(messages), { busy: true, liveMessageId: 'cmp2' });
    expect(again.find((t) => t.live)?.id).toBe('cmp2:continued');
    expect(again[2]!.user).toBe(turns[2]!.user);
    // A compaction between turns (a `/summarize`) keeps its own turn: the next prompt's replies follow it.
    expect(sessionLogTurns(thread([user('u1'), reply('a1', 'u1'), msg('cmp3', 'user', [block], { kind: 'compaction' }), user('u2'), reply('b1', 'u2')])).map((t) => t.id))
      .toEqual(['u1', 'cmp3', 'u2']);
  });

  test('threads: a sub-thread the turn spawned, by its head or by the call that names it', () => {
    const spawn = call('k1', 'task', { kind: 'task' });
    const t = thread([user('u1'), reply('a1', 'u1', [spawn]), user('u2'), reply('a2', 'u2', [call('k2', 'task', { kind: 'task' })])]);
    const child = thread([], { thread_id: 'child-1', parent_thread_id: 't', spawned_by: { message_id: 'a1', call_id: 'call_k1' } });
    const turns = sessionLogTurns(t, { threads: [t, child] });
    expect(turns.map((x) => x.threads)).toEqual([['child-1'], []]);
  });

  test('plan: the turn that last wrote the todo list owns the plan card, else the last turn', () => {
    const write = call('w', 'todowrite', { kind: 'todo' });
    expect(sessionLogTurns(thread([user('u1'), reply('a1', 'u1', [write]), user('u2'), reply('a2', 'u2', [call('r', 'todoread', { kind: 'todo' })])])).map((x) => x.plan)).toEqual([true, false]);
    expect(sessionLogTurns(thread([user('u1'), user('u2')])).map((x) => x.plan)).toEqual([false, true]);
  });

  test('shell, response and attachments', () => {
    const bash = call('b', 'bash', { kind: 'shell' });
    const [shell, chat] = sessionLogTurns(thread([
      msg('u1', 'user', [{ type: 'text', id: 's', text: 'ls', synthetic: true }]),
      reply('a1', 'u1', [bash]),
      msg('u2', 'user', [
        { type: 'text', id: 'p', text: 'look' },
        { type: 'attachment', id: 'img', mime: 'image/png', ref: 'kortix-attachment://p/s/a', bytes: 3 },
        { type: 'attachment', id: 'zip', mime: 'application/zip' },
      ]),
      reply('a2', 'u2', [{ type: 'text', id: 'x1', text: 'first' }, { type: 'text', id: 'x2', text: '  ' }]),
    ]));
    expect(shell!.shell).toBe(bash);
    expect(chat!.shell).toBeNull();
    expect(chat!.response?.id).toBe('x1');
    expect(chat!.attachments.map((b) => b.id)).toEqual(['img']);
    expect(chat!.blocks.map((b) => b.id)).toEqual(['x1', 'x2']);
  });
});

describe('liveness', () => {
  test('the working turn: the hinted one, else the newest streaming reply; live only while the session is busy', () => {
    const messages = [user('u1'), reply('a1', 'u1'), user('u2'), reply('a2', 'u2', undefined, { status: 'streaming' }), user('u3')];
    expect(sessionLogTurns(thread(messages), { busy: true }).map((t) => [t.live, t.queued])).toEqual([[false, false], [true, false], [false, true]]);
    expect(sessionLogTurns(thread(messages), { busy: false }).map((t) => t.live)).toEqual([false, false, false]);
    expect(sessionLogTurns(thread(messages), { busy: true, liveMessageId: 'u3' }).map((t) => t.live)).toEqual([false, false, true]);
  });

  test('sessionLogCallStatus: an open or closure-rule call is in progress on a live turn and interrupted on any other', () => {
    const running = call('r', 'bash', { status: 'running', result: undefined, started_at: '2026-10-01T00:00:00Z' });
    const pending = call('p', 'bash', { status: 'pending', result: undefined });
    const closed = (started?: string) =>
      call('c', 'bash', { status: 'error', ...(started && { started_at: started }), result: { content: [{ type: 'text', text: '[Tool execution was interrupted]' }], is_error: true, synthetic: true, error: { code: 'interrupted', message: 'x' } } });
    const failed = call('f', 'bash', { status: 'error', result: { content: [], is_error: true, error: { message: 'exit 1' } } });
    expect([running, pending, closed('2026-10-01T00:00:00Z'), closed(), failed, call('d', 'bash')].map((c) => sessionLogCallStatus(c, true))).toEqual([
      'running', 'pending', 'running', 'pending', 'error', 'complete',
    ]);
    expect([running, pending, closed(), failed, call('d', 'bash')].map((c) => sessionLogCallStatus(c, false))).toEqual([
      'interrupted', 'interrupted', 'interrupted', 'error', 'complete',
    ]);
  });

  test('retrying: only the session\'s last reply, open with a retryable error, retries', () => {
    const retry = { status: 'error' as const, completed_at: null, error: { code: 'rate_limit', message: 'slow down' } };
    // A native record carries no isRetryable flag: its last open errored reply is not a retry.
    expect(sessionLogTurns(thread([user('u1'), reply('a1', 'u1', undefined, retry)])).map((t) => t.retrying)).toEqual([false]);
  });
});

describe('sessionLogRetrying', () => {
  const rows = (completed: boolean) => [
    { info: { id: 'msg_u', sessionID: 'ses', role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_q', sessionID: 'ses', messageID: 'msg_u', type: 'text', text: 'go' }] },
    {
      info: {
        id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_u', time: completed ? { created: 2, completed: 3 } : { created: 2 },
        error: { name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429, isRetryable: true } },
      },
      parts: [{ id: 'prt_x', sessionID: 'ses', messageID: 'msg_a', type: 'text', text: 'x' }],
    },
  ];
  test('the thread\'s last reply is open with a retryable error: the same answer the turn layer gives, without turns', () => {
    const open = sessionLogOfV1Rows('kses', 'ses', rows(false) as never).threads[0]!;
    expect(sessionLogRetrying(open)).toBe(true);
    expect(sessionLogTurns(open).map((t) => t.retrying)).toEqual([true]);
    const done = sessionLogOfV1Rows('kses', 'ses', rows(true) as never).threads[0]!;
    expect(sessionLogRetrying(done)).toBe(false);
    expect(sessionLogRetrying(thread([user('u1')]))).toBe(false);
  });
});
