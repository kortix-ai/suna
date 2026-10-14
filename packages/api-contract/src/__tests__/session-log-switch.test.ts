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

describe('switchPreflight: the loss report of a harness switch', () => {
  test('OpenCode → pi lists the todos, the PDF, the MCP tools and the rewind; the sub-agent is native on pi', () => {
    const report = switchPreflight(openCodeSession(), 'pi');
    expect(report).toEqual({
      session_id: 'ses_synthetic', from: 'opencode', to: 'pi',
      losses: [
        { feature: 'attachments.user', detail: 'application/pdf', used: 1, status: 'lost' },
        { feature: 'todos', used: 1, status: 'lost' },
        { feature: 'session.mcp', detail: 'github_search', used: 2, status: 'lost' },
        { feature: 'session.rewind', used: 1, status: 'lost' },
      ],
    });
    expect(SessionLogSwitchPreflightSchema.parse(report)).toEqual(report);
  });

  test('OpenCode → OpenCode and pi → OpenCode lose nothing', () => {
    expect(switchPreflight(openCodeSession(), 'opencode').losses).toEqual([]);
    const pi = log('pi', [
      thread('ses_pi1', null, [
        msg('ses_pi1', 'user', [{ type: 'attachment', id: 'i', mime: 'image/png', ref: 'blob:y', bytes: 1, sha256: 'b'.repeat(64) }], { origin: 'steer' }),
        msg('ses_pi1', 'assistant', [call('k1', 'task', 'task'), { type: 'compaction', id: 'cm', summary: 's', first_kept_message_id: null, trigger: 'manual' }]),
      ]),
      thread('child', 'ses_pi1', []),
    ]);
    expect(switchPreflight(pi, 'opencode').losses).toEqual([]);
  });

  test('a feature the source harness also lacked is no loss; a converted log counts every feature as native at the source', () => {
    const failed = call('e1', 'bash', 'shell', { status: 'error', result: { content: [{ type: 'text', text: 'boom' }], is_error: true } });
    const threads = () => [thread('r', null, [msg('r', 'assistant', [failed])])];
    expect(switchPreflight(log('opencode', threads()), 'pi').losses).toEqual([]);
    expect(switchPreflight(log('kortix-v1-import', threads()), 'pi').losses).toEqual([{ feature: 'tool_error_channel', used: 1, status: 'lost' }]);
  });

  test('a lowered feature is degraded; async sub-agents and a freeform input are lost', () => {
    const image = call('t1', 'screenshot', 'other', { result: { content: [{ type: 'attachment', mime: 'image/png', ref: 'blob:z', sha256: 'c'.repeat(64) }], is_error: false } });
    const freeform = call('t2', 'apply_patch', 'patch', { input: 'diff', input_format: 'text' });
    const layout: SessionLogBlock = { type: 'compaction', id: 'l', summary: 's', first_kept_message_id: null, layout: [{ summary: true }] };
    const opaque: SessionLogBlock = { type: 'compaction', id: 'o', summary: null, opaque: true, first_kept_message_id: null };
    const root = thread('r', null, [msg('r', 'assistant', [image, freeform, layout, opaque])]);
    const child = thread('a', 'r', [], { interactions: [{ message_id: 'msg_x', call_id: 'c', op: 'spawn' }] });
    expect(switchPreflight(log('codex', [root, child]), 'opencode').losses).toEqual([
      { feature: 'freeform_tool_input', used: 1, status: 'lost' },
      { feature: 'attachments.tool_result', used: 1, status: 'degraded' },
      { feature: 'compaction', detail: 'layout', used: 1, status: 'degraded' },
      { feature: 'compaction', detail: 'opaque', used: 1, status: 'lost' },
      { feature: 'subagents', detail: 'async', used: 1, status: 'lost' },
    ]);
  });

  test('every golden log gives a report the wire schema accepts, to each harness', () => {
    const dir = join(import.meta.dir, 'fixtures', 'session-log');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.v2.json'))) {
      const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SessionLog;
      for (const to of ['pi', 'opencode'] as const) SessionLogSwitchPreflightSchema.parse(switchPreflight(fixture, to));
    }
  });
});
