import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  SessionLogSwitchPreflightSchema,
  switchPreflight,
  type SessionLog,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogThread,
  type SwitchGap,
} from '../session-log';

const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const;
const T = '2026-10-14T10:00:00.000Z';
let n = 0;

function msg(thread: string, role: SessionLogMessage['role'], blocks: SessionLogBlock[], over: Partial<SessionLogMessage> = {}): SessionLogMessage {
  n++;
  return {
    ...V, message_id: `msg_${n}`, thread_id: thread, seq: n, role, kind: 'turn', status: 'complete', in_context: true,
    model: null, usage: null, finish: null, error: null, created_at: T, completed_at: T,
    producer: { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1' }, blocks, ...over,
  };
}
const thread = (id: string, parent: string | null, messages: SessionLogMessage[], over: Partial<SessionLogThread> = {}): SessionLogThread => ({
  ...V, thread_id: id, parent_thread_id: parent, spawned_by: null, agent: null, title: null, created_at: T, messages, ...over,
});
const call = (id: string, name: string, kind: string, over: Record<string, unknown> = {}): SessionLogBlock =>
  ({ type: 'tool_call', id, call_id: id, name, kind, input: {}, status: 'complete', result: { content: [{ type: 'text', text: 'ok' }], is_error: false }, ...over }) as SessionLogBlock;
const log = (harness: string, threads: SessionLogThread[], over: Partial<SessionLog> = {}): SessionLog => ({
  ...V, session_id: 'ses_synthetic', title: null, created_at: T, restore_grade: 'native',
  harness: { current: harness, history: [{ harness, version: '1', from_seq: 1, at: T }] },
  selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] }, threads, ...over,
});

/** An OpenCode session: a sub-agent, a todo list, a PDF, an MCP tool, a rewind, a slash command. */
function openCodeSession(): SessionLog {
  const root = thread('ses_root', null, [
    msg('ses_root', 'user', [{ type: 'text', id: 'p1', text: 'read this' }, { type: 'attachment', id: 'p2', mime: 'application/pdf', ref: 'blob:x', bytes: 3, sha256: 'a'.repeat(64) }]),
    msg('ses_root', 'assistant', [call('c1', 'task', 'task'), call('c2', 'todowrite', 'todo'), call('c3', 'github_search', 'mcp'), call('c4', 'github_search', 'mcp')]),
    msg('ses_root', 'user', [{ type: 'text', id: 'p3', text: 'undo' }], { in_context: false, hidden_reason: 'reverted' }),
    msg('ses_root', 'user', [{ type: 'text', id: 'p4', text: '/review' }], { origin: 'command' }),
  ]);
  const child = thread('ses_child', 'ses_root', [msg('ses_child', 'user', [{ type: 'text', id: 'p5', text: 'list' }])]);
  return log('opencode', [root, child], { todos: [{ content: 'ship', status: 'pending' }] });
}

const OK = { llmGateway: true, restore: true };
/** Everything OpenCode handles that pi lacks, used or not. */
const OPENCODE_TO_PI: SwitchGap[] = [
  { feature: 'attachments.user', detail: 'application/pdf', status: 'lost' },
  // OpenCode shows another model's reasoning as text; pi drops it.
  { feature: 'reasoning_replay', detail: 'other_model', status: 'lost' },
  { feature: 'todos', status: 'lost' },
  ...['session.rewind', 'session.fork', 'session.mcp', 'session.todo', 'session.shell', 'session.attach', 'session.config'].map((feature): SwitchGap => ({ feature, status: 'lost' })),
];

describe('switchPreflight: the loss report of a harness switch', () => {
  test('OpenCode → pi lists the todos, the PDF, the MCP tools and the rewind; the sub-agent is native on pi', () => {
    const report = switchPreflight(openCodeSession(), 'pi', OK);
    expect(report).toEqual({
      session_id: 'ses_synthetic', from: 'opencode', to: 'pi', available: true, reason: null, restores: true,
      losses: [
        { feature: 'attachments.user', detail: 'application/pdf', used: 1, status: 'lost' },
        { feature: 'todos', used: 1, status: 'lost' },
        { feature: 'session.rewind', used: 1, status: 'lost' },
        { feature: 'session.mcp', detail: 'github_search', used: 2, status: 'lost' },
      ],
      unsupported: OPENCODE_TO_PI,
    });
    expect(SessionLogSwitchPreflightSchema.parse(report)).toEqual(report);
  });

  test('OpenCode → OpenCode and pi → OpenCode lose nothing', () => {
    expect(switchPreflight(openCodeSession(), 'opencode', OK).losses).toEqual([]);
    const pi = log('pi', [
      thread('ses_pi1', null, [
        msg('ses_pi1', 'user', [{ type: 'attachment', id: 'i', mime: 'image/png', ref: 'blob:y', bytes: 1, sha256: 'b'.repeat(64) }], { origin: 'steer' }),
        msg('ses_pi1', 'assistant', [call('k1', 'task', 'task'), { type: 'compaction', id: 'cm', summary: 's', first_kept_message_id: null, trigger: 'manual' }]),
      ]),
      thread('child', 'ses_pi1', []),
    ]);
    expect(switchPreflight(pi, 'opencode', OK).losses).toEqual([]);
  });

  test('a feature the source harness also lacked is no loss; a converted log counts every feature as native at the source', () => {
    const failed = call('e1', 'bash', 'shell', { status: 'error', result: { content: [{ type: 'text', text: 'boom' }], is_error: true } });
    const threads = () => [thread('r', null, [msg('r', 'assistant', [failed])])];
    expect(switchPreflight(log('opencode', threads()), 'pi', OK).losses).toEqual([]);
    expect(switchPreflight(log('kortix-v1-import', threads()), 'pi', OK).losses).toEqual([{ feature: 'tool_error_channel', used: 1, status: 'lost' }]);
  });

  test('a lowered feature is degraded; async sub-agents and a freeform input are lost', () => {
    const image = call('t1', 'screenshot', 'other', { result: { content: [{ type: 'attachment', mime: 'image/png', ref: 'blob:z', sha256: 'c'.repeat(64) }], is_error: false } });
    const freeform = call('t2', 'apply_patch', 'patch', { input: 'diff', input_format: 'text' });
    const layout: SessionLogBlock = { type: 'compaction', id: 'l', summary: 's', first_kept_message_id: null, layout: [{ summary: true }] };
    const opaque: SessionLogBlock = { type: 'compaction', id: 'o', summary: null, opaque: true, first_kept_message_id: null };
    const root = thread('r', null, [msg('r', 'assistant', [image, freeform, layout, opaque])]);
    const child = thread('a', 'r', [], { interactions: [{ message_id: 'msg_x', call_id: 'c', op: 'spawn' }] });
    expect(switchPreflight(log('codex', [root, child]), 'opencode', OK).losses).toEqual([
      { feature: 'freeform_tool_input', used: 1, status: 'lost' },
      { feature: 'attachments.tool_result', used: 1, status: 'degraded' },
      { feature: 'compaction', detail: 'layout', used: 1, status: 'degraded' },
      { feature: 'compaction', detail: 'opaque', used: 1, status: 'lost' },
      { feature: 'subagents', detail: 'async', used: 1, status: 'lost' },
    ]);
  });

  test('reasoning: OpenCode showed another model\'s reasoning as text, pi drops it (lost); the next model\'s own reasoning survives both ways', () => {
    const think = (id: string, model: string): SessionLogMessage =>
      msg('r', 'assistant', [{ type: 'reasoning', id, text: 'thinking' }], { model: { provider: 'kortix', model } });
    const reasoning = (harness: string) =>
      log(harness, [thread('r', null, [think('a', 'glm-5.3-flash'), think('b', 'other-model'), { ...think('c', 'other-model'), in_context: false }])], {
        selection: { agent: null, model: { provider: 'kortix', model: 'glm-5.3-flash' } },
      });
    expect(switchPreflight(reasoning('opencode'), 'pi', OK).losses).toEqual([{ feature: 'reasoning_replay', detail: 'other_model', used: 1, status: 'lost' }]);
    expect(switchPreflight(reasoning('pi'), 'opencode', OK).losses).toEqual([]);
  });

  test('unsupported lists what the target lacks before any use: a session that never called its MCP servers', () => {
    const fresh = log('opencode', [thread('r', null, [msg('r', 'user', [{ type: 'text', id: 't', text: 'hi' }])])]);
    const report = switchPreflight(fresh, 'pi', OK);
    expect(report.losses).toEqual([]);
    expect(report.unsupported).toEqual(OPENCODE_TO_PI);
    expect(switchPreflight(log('pi', []), 'opencode', OK).unsupported).toEqual([]);
  });

  test('the verdict: the same harness and pi without the gateway are not available; no restore loses the whole history first', () => {
    const session = openCodeSession();
    expect(switchPreflight(session, 'opencode', OK)).toMatchObject({ available: false, reason: 'same_harness', losses: [] });
    expect(switchPreflight(session, 'pi', { llmGateway: false, restore: true })).toMatchObject({ available: false, reason: 'llm_gateway_off' });
    const noRestore = switchPreflight(session, 'pi', { llmGateway: true, restore: false });
    expect(noRestore).toMatchObject({ available: true, reason: null, restores: false });
    expect(noRestore.losses[0]).toEqual({ feature: 'history', used: 5, status: 'lost' });
    expect(switchPreflight(log('opencode', []), 'pi', { llmGateway: true, restore: false }).losses).toEqual([]);
  });

  test('deleted messages count as a rewind; a harness name that is an Object key is no manifest', () => {
    const fresh = () => [thread('r', null, [msg('r', 'user', [{ type: 'text', id: 't', text: 'hi' }])])];
    expect(switchPreflight(log('opencode', fresh()), 'pi', { ...OK, deletedMessages: 3 }).losses).toEqual([{ feature: 'session.rewind', used: 3, status: 'lost' }]);
    const report = switchPreflight(log('constructor', fresh()), 'pi', OK);
    expect(report.from).toBe('constructor');
    expect(SessionLogSwitchPreflightSchema.parse(report)).toEqual(report);
  });

  test('every golden log gives a report the wire schema accepts, to each harness', () => {
    const dir = join(import.meta.dir, 'fixtures', 'session-log');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.v2.json'))) {
      const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SessionLog;
      for (const to of ['pi', 'opencode'] as const) SessionLogSwitchPreflightSchema.parse(switchPreflight(fixture, to, OK));
    }
  });
});
