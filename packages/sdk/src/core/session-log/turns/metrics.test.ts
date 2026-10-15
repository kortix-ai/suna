/**
 * `sessionLogThreadMetrics`: what the context modal's overview and its sub-agent rows read
 * from one thread — the cost, the message counts and the token totals.
 */
import { describe, expect, test } from 'bun:test';
import { COST_MARKUP } from '../../turns';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLogBlock, type SessionLogMessage, type SessionLogThread } from '../types';
import { sessionLogOfV1Rows } from '../v1-view';
import { sessionLogThreadMetrics, sessionLogTurns } from './index';

const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
const PRODUCER = { harness: 'pi', harness_version: '1', adapter_version: '1' };
let seq = 0;
function msg(id: string, role: 'user' | 'assistant', blocks: SessionLogBlock[], over: Partial<SessionLogMessage> = {}): SessionLogMessage {
  seq += 1;
  return {
    ...V, message_id: id, thread_id: 't', seq, role, kind: 'turn', status: 'complete', in_context: true,
    model: { provider: 'kortix', model: 'm' }, usage: null, finish: role === 'assistant' ? 'stop' : null, error: null,
    created_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), completed_at: null, producer: PRODUCER, blocks, ...over,
  };
}
const user = (id: string, over: Partial<SessionLogMessage> = {}) => msg(id, 'user', [{ type: 'text', id: `${id}-t`, text: id }], over);
const reply = (id: string, to: string, usage: SessionLogMessage['usage'], over: Partial<SessionLogMessage> = {}) =>
  msg(id, 'assistant', [{ type: 'text', id: `${id}-t`, text: 'ok' }], { reply_to: to, usage, ...over });
/** A compaction: the v1 marker and its summary reply folded into one record; `usage` is the summary's. */
const compaction = (id: string, usage: SessionLogMessage['usage'], status: SessionLogMessage['status'] = 'complete') =>
  msg(id, 'user', [{ type: 'compaction', id: `${id}-c`, summary: 'summary', first_kept_message_id: null }], { kind: 'compaction', status, usage });
const thread = (messages: SessionLogMessage[]): SessionLogThread => ({
  ...V, thread_id: 't', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages,
});
const lookup = () => ({ inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.1, cacheWritePer1M: 2 });

test('COST_MARKUP is the 5.5% platform fee on managed model usage', () => {
  expect(COST_MARKUP).toBe(1.055);
});

describe('sessionLogThreadMetrics', () => {
  test('an empty thread is all zeros', () => {
    expect(sessionLogThreadMetrics(thread([]))).toEqual({
      cost: 0, messages: { all: 0, user: 0, assistant: 0 },
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      context: null,
    });
  });

  test('cost is the turns\' cost summed; tokens are every reply\'s usage summed, not just the last', () => {
    const t = thread([
      user('u1'),
      reply('a1', 'u1', { input: 2, output: 3, reasoning: 4, cache_read: 5, cache_write: 6, cost: 0.5 }),
      reply('a2', 'u1', { input: 7, output: 8, reasoning: 9, cache_read: 10, cache_write: 11 }),
      user('u2'),
      reply('a3', 'u2', { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: 0.25 }),
    ]);
    const m = sessionLogThreadMetrics(t, { pricing: lookup });
    const turns = sessionLogTurns(t, { pricing: lookup });
    expect(m.cost).toBeCloseTo(turns.reduce((sum, turn) => sum + (turn.cost?.cost ?? 0), 0), 12);
    // a2 reports no cost: the lookup prices its tokens, so the total is more than the reported costs with the markup.
    expect(m.cost).toBeGreaterThan((0.5 + 0.25) * COST_MARKUP);
    expect(sessionLogThreadMetrics(t).cost).toBeCloseTo((0.5 + 0.25) * COST_MARKUP, 12);
    expect(m.tokens).toEqual({ input: 10, output: 12, reasoning: 13, cacheRead: 15, cacheWrite: 17 });
    expect(m.messages).toEqual({ all: 5, user: 2, assistant: 3 });
  });

  test('a compaction counts as its user marker and, once it is no longer streaming, its summary reply; its usage is priced', () => {
    const done = thread([user('u1'), reply('a1', 'u1', { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: 0.1 }), compaction('c1', { input: 50, output: 5, cache_read: 0, cache_write: 0, cost: 0.2 })]);
    const m = sessionLogThreadMetrics(done, { pricing: lookup });
    expect(m.messages).toEqual({ all: 4, user: 2, assistant: 2 });
    expect(m.tokens).toEqual({ input: 51, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(m.cost).toBeCloseTo((0.1 + 0.2) * COST_MARKUP, 12);
    // The turn layer agrees: the compaction turn's cost is the summary's usage.
    const turn = sessionLogTurns(done, { pricing: lookup }).find((t) => t.compaction);
    expect(turn!.cost!.cost).toBeCloseTo(0.2 * COST_MARKUP, 12);

    const streaming = thread([user('u1'), compaction('c1', null, 'streaming')]);
    expect(sessionLogThreadMetrics(streaming).messages).toEqual({ all: 2, user: 2, assistant: 0 });
  });

  test('a reply without usage adds nothing; a system message is not counted', () => {
    const t = thread([
      user('u1'),
      reply('a1', 'u1', null),
      { ...msg('s1', 'user', [{ type: 'text', id: 's1-t', text: 'sys' }]), role: 'system' },
    ]);
    const m = sessionLogThreadMetrics(t, { pricing: lookup });
    expect(m).toEqual({ cost: 0, messages: { all: 2, user: 1, assistant: 1 }, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, context: null });
  });

  test('context is the last reply with tokens: an assistant message or a compaction; a zero-usage reply is skipped', () => {
    const a1 = reply('a1', 'u1', { input: 3, output: 1, cache_read: 0, cache_write: 0 });
    const zero = reply('a2', 'u2', { input: 0, output: 0, cache_read: 0, cache_write: 0 });
    expect(sessionLogThreadMetrics(thread([user('u1'), a1, user('u2'), zero])).context).toBe(a1);
    const c1 = compaction('c1', { input: 5, output: 1, cache_read: 0, cache_write: 0 });
    expect(sessionLogThreadMetrics(thread([user('u1'), a1, c1, user('u2')])).context).toBe(c1);
  });

  test('a thread with no user message still sums every reply', () => {
    const t = thread([
      reply('a1', 'gone', { input: 1, output: 2, cache_read: 0, cache_write: 0 }, { reply_to: null }),
      reply('a2', 'gone', { input: 3, output: 4, cache_read: 0, cache_write: 0 }, { reply_to: null }),
    ]);
    const m = sessionLogThreadMetrics(t);
    expect(m.tokens).toEqual({ input: 4, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(m.messages).toEqual({ all: 2, user: 0, assistant: 2 });
  });
});

describe('sessionLogThreadMetrics on a thread converted from v1', () => {
  test('every reply\'s usage is priced (the context modal\'s totals), not only the replies with a step part', () => {
    const rows = [
      { info: { id: 'msg_u', sessionID: 'ses', role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_q', sessionID: 'ses', messageID: 'msg_u', type: 'text', text: 'go' }] },
      {
        info: { id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_u', time: { created: 2, completed: 3 }, providerID: 'anthropic', modelID: 'm', cost: 0, tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [],
      },
    ];
    const view = sessionLogOfV1Rows('kses', 'ses', rows as never).threads[0]!;
    const m = sessionLogThreadMetrics(view, { pricing: lookup });
    expect(m.tokens.input).toBe(1_000_000);
    expect(m.cost).toBeCloseTo(1 * COST_MARKUP, 9);
    // The transcript's turn row keeps v1's `getTurnCost` rule: it prices parts, and this reply has none.
    expect(sessionLogTurns(view, { pricing: lookup })[0]!.cost).toBeNull();
  });
});
