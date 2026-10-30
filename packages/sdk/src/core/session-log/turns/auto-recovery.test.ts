/**
 * Automatic provider-error recovery must not spam the transcript (KRTX-2597).
 *
 * When a provider outage kills a turn, the harness resumes it with its OWN
 * prompt (`[auto-recovery] …`, delivered as a synthetic part). The transcript
 * then showed every failed attempt as its own error row plus the recovery
 * prompts as ordinary user bubbles — four identical "temporarily unavailable"
 * rows and three jargon bubbles over one outage, with no terminal state.
 *
 * The block model carries the facts a transcript needs to render the chain as
 * ONE story: which turns are the harness's own continuations (`internal`), and
 * which error rows yield to a following retry (`autoRetry`). The terminal turn
 * of a chain reports how many automatic retries preceded it.
 */
import { describe, expect, test } from 'bun:test';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLogMessage, type SessionLogThread } from '../types';
import { sessionLogOfV1Rows } from '../v1-view';
import { sessionLogTurns } from './index';

const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
const PRODUCER = { harness: 'opencode', harness_version: '1', adapter_version: '1' };
let seq = 0;
function msg(id: string, role: 'user' | 'assistant', blocks: SessionLogMessage['blocks'], over: Partial<SessionLogMessage> = {}): SessionLogMessage {
  seq += 1;
  return {
    ...V, message_id: id, thread_id: 't', seq, role, kind: 'turn', status: 'complete', in_context: true,
    model: role === 'assistant' ? { provider: 'kortix', model: 'm' } : null,
    usage: role === 'assistant' ? { input: 10, output: 2, cache_read: 0, cache_write: 0, cost: 0.01 } : null,
    finish: role === 'assistant' ? 'stop' : null, error: null,
    created_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    completed_at: null, producer: PRODUCER, blocks, ...over,
  };
}
const user = (id: string, t = id, over: Partial<SessionLogMessage> = {}) =>
  msg(id, 'user', [{ type: 'text', id: `${id}-t`, text: t }], over);
/** The harness's own continuation prompt: the part the harness marked synthetic. */
const autoRecoveryPrompt = (id: string) =>
  msg(id, 'user', [{ type: 'text', id: `${id}-t`, text: '[auto-recovery] Your previous response was interrupted by a transient provider error.', synthetic: true }]);
const reply = (id: string, to: string, over: Partial<SessionLogMessage> = {}) =>
  msg(id, 'assistant', [{ type: 'text', id: `${id}-t`, text: 'working on it' }], { reply_to: to, ...over });
/** A reply the provider outage killed (a failed attempt: out of context, error kept). */
const failedReply = (id: string, to: string) =>
  reply(id, to, {
    status: 'error', in_context: false, hidden_reason: 'failed_attempt',
    error: { code: 'model_unavailable', message: 'deepseek-v4.1-flash is temporarily unavailable.' },
  });
const thread = (messages: SessionLogMessage[], over: Partial<SessionLogThread> = {}): SessionLogThread =>
  ({ ...V, thread_id: 't', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages, ...over });

describe('sessionLogTurns — automatic provider-error recovery (KRTX-2597)', () => {
  test('a synthetic-only prompt marks its turn internal; a person prompt does not', () => {
    const turns = sessionLogTurns(thread([
      user('u1', 'Fix the login bug'),
      failedReply('a1', 'u1'),
      autoRecoveryPrompt('u2'),
      failedReply('a2', 'u2'),
      reply('ok', 'u2'),
    ]));
    expect(turns.map((t) => [t.id, t.internal])).toEqual([
      ['u1', false],
      ['u2', true],
    ]);
  });

  test('a turn a continuation follows yields its error row; the chain end carries the retry count', () => {
    const turns = sessionLogTurns(thread([
      user('u1', 'Fix the login bug'),
      failedReply('a1', 'u1'),
      autoRecoveryPrompt('u2'),
      failedReply('a2', 'u2'),
      autoRecoveryPrompt('u3'),
      failedReply('a3', 'u3'),
      autoRecoveryPrompt('u4'),
      failedReply('a4', 'u4'),
    ]));
    expect(turns.map((t) => [t.id, t.internal, t.autoRetry ?? null])).toEqual([
      ['u1', false, { continued: true, retries: 0 }],
      ['u2', true, { continued: true, retries: 0 }],
      ['u3', true, { continued: true, retries: 0 }],
      ['u4', true, { continued: false, retries: 3 }],
    ]);
  });

  test('a retry that succeeds ends the chain: no error row renders anywhere', () => {
    const turns = sessionLogTurns(thread([
      user('u1', 'Fix the login bug'),
      failedReply('a1', 'u1'),
      autoRecoveryPrompt('u2'),
      failedReply('a2', 'u2'),
      autoRecoveryPrompt('u3'),
      reply('ok', 'u3'),
    ]));
    expect(turns.map((t) => [t.id, t.internal, t.autoRetry ?? null, t.error?.code ?? null])).toEqual([
      ['u1', false, { continued: true, retries: 0 }, 'model_unavailable'],
      ['u2', true, { continued: true, retries: 0 }, 'model_unavailable'],
      ['u3', true, null, null],
    ]);
  });

  test('the customer interjecting breaks the chain: their own failure is its own terminal row', () => {
    const turns = sessionLogTurns(thread([
      user('u1', 'Fix the login bug'),
      failedReply('a1', 'u1'),
      autoRecoveryPrompt('u2'),
      failedReply('a2', 'u2'),
      user('u3', 'hello?'),
      failedReply('a3', 'u3'),
    ]));
    expect(turns.map((t) => [t.id, t.internal, t.autoRetry ?? null])).toEqual([
      ['u1', false, { continued: true, retries: 0 }],
      ['u2', true, { continued: false, retries: 1 }],
      ['u3', false, null],
    ]);
  });

  test('a plain conversation is untouched: no internal turns, no autoRetry', () => {
    const turns = sessionLogTurns(thread([
      user('u1'),
      failedReply('a1', 'u1'),
      user('u2'),
      reply('a2', 'u2'),
    ]));
    expect(turns.map((t) => [t.id, t.internal, t.autoRetry ?? null])).toEqual([
      ['u1', false, null],
      ['u2', false, null],
    ]);
  });

  test('a failed turn with no continuation renders as before (the outage ended without a resume)', () => {
    const turns = sessionLogTurns(thread([
      user('u1', 'Fix the login bug'),
      failedReply('a1', 'u1'),
    ]));
    expect(turns[0]).toMatchObject({ internal: false, autoRetry: undefined, error: { code: 'model_unavailable' } });
  });

  test('the harness context of a person prompt (mixed synthetic + real text) is not internal', () => {
    const turns = sessionLogTurns(thread([
      msg('u1', 'user', [
        { type: 'text', id: 'u1-real', text: 'Fix the login bug' },
        { type: 'text', id: 'u1-ctx', text: 'AGENTS.md contents…', synthetic: true },
      ]),
      reply('a1', 'u1'),
    ]));
    expect(turns[0]).toMatchObject({ internal: false, autoRetry: undefined });
  });

  test('an unloadable prompt stand-in (no blocks) is never internal', () => {
    const turns = sessionLogTurns(thread([
      reply('early', 'gone'),
      user('u1'),
    ]));
    expect(turns.map((t) => [t.id, t.internal])).toEqual([['gone', false], ['u1', false]]);
  });

  test('the same facts hold on a v1-derived thread (the OpenCode mirror path)', () => {
    const rows = thread([
      user('u1', 'Fix the login bug'),
      failedReply('a1', 'u1'),
      autoRecoveryPrompt('u2'),
      failedReply('a2', 'u2'),
      autoRecoveryPrompt('u3'),
      reply('ok', 'u3'),
    ]).messages.map((m) => ({
      runtime_session_id: 'ses',
      info: {
        id: m.message_id, role: m.role as 'user' | 'assistant',
        time: { created: Date.parse(m.created_at), completed: Date.parse(m.created_at) + 1 },
        ...(m.role === 'assistant'
          ? {
              parentID: m.reply_to ?? undefined,
              ...(m.error ? { error: { name: 'APIError', data: { message: m.error.message, statusCode: 503, isRetryable: false } } } : {}),
            }
          : {}),
      },
      parts: m.blocks.map((b) => ({ id: b.id, type: 'text' as const, text: (b as { text: string }).text, ...((b as { synthetic?: boolean }).synthetic ? { synthetic: true } : {}) })),
    }));
    const v1 = sessionLogOfV1Rows('p', 'ses', rows as never).threads[0]!;
    const turns = sessionLogTurns(v1);
    expect(turns.map((t) => [t.id, t.internal, t.autoRetry ?? null])).toEqual([
      ['u1', false, { continued: true, retries: 0 }],
      ['u2', true, { continued: true, retries: 0 }],
      ['u3', true, null],
    ]);
  });
});
