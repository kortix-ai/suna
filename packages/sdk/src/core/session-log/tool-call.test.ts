import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '../runtime/runtime-types';
import { contextToolTrigger } from '../turns/tools/tool-meta';
import { partOutcome } from '../turns/tools/tool-outcome';
import { getChildSessionId, shouldShowToolPart } from '../turns/parts';
import { toToolView } from '../turns/classify';
import { toolCallBlock, toolCallMetadata } from './tool-call';
import type { ToolCallBlock } from './types';
import { fromV1, type V1Row } from './v1';

// Synthetic tool parts: every id and value is invented.
const SID = 'ses_tc000000000000000000001';
const CHILD = 'ses_tcchild0000000000000001';
const MID = 'msg_tc01';
const T0 = 1_790_000_000_000;
const part = (id: string, tool: string, state: Record<string, unknown>): ToolPart =>
  ({ id, sessionID: SID, messageID: MID, type: 'tool', callID: `call_${id}`, tool, state }) as unknown as ToolPart;

const PARTS: Record<string, ToolPart> = {
  bash: part('prt_bash', 'bash', { status: 'completed', input: { command: 'ls -la', description: 'Lists files' }, output: 'a\nb\n', title: 'Lists files', metadata: { command: 'ls -la', output: 'a\nb\n', exit: 0, description: 'Lists files' }, time: { start: T0, end: T0 + 20 } }),
  read: part('prt_read', 'read', { status: 'completed', input: { filePath: '/w/a.ts' }, output: '<file>\n1| x\n</file>', title: 'a.ts', metadata: { preview: 'x', loaded: ['/w/b.ts'] }, time: { start: T0 + 30, end: T0 + 40 } }),
  edit: part('prt_edit', 'edit', { status: 'completed', input: { filePath: '/w/a.ts', oldString: 'x', newString: 'y' }, output: 'Edit applied.', title: 'a.ts', metadata: { filediff: { file: '/w/a.ts', before: 'x', after: 'y', additions: 1, deletions: 1 }, diagnostics: { '/w/a.ts': [] } }, time: { start: T0 + 50, end: T0 + 60 } }),
  task: part('prt_task', 'task', { status: 'running', input: { description: 'sub', prompt: 'go', subagent_type: 'general' }, title: 'sub', metadata: { sessionId: CHILD }, time: { start: T0 + 70 } }),
  question: part('prt_q', 'question', { status: 'completed', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] }, output: 'A', title: 'Asked 1 question', metadata: { answers: [['A']] }, time: { start: T0 + 80, end: T0 + 90 } }),
  pending: part('prt_write', 'write', { status: 'pending', input: {}, raw: '{"filePath":"/w/c.ts"' }),
  failed: part('prt_err', 'edit', { status: 'error', input: { filePath: '/w/missing' }, error: 'File not found', time: { start: T0 + 100, end: T0 + 110 } }),
  todoread: part('prt_todo', 'todoread', { status: 'completed', input: {}, output: '[]', title: '0 todos', metadata: { todos: [] }, time: { start: T0 + 120, end: T0 + 121 } }),
};

/** The same parts as the mirror stores them, converted at rest (the API's read of a finished turn). */
function atRest(): Map<string, ToolCallBlock> {
  const row: V1Row = { runtime_session_id: SID, info: { id: MID, sessionID: SID, role: 'assistant', time: { created: T0 } } as never, parts: Object.values(PARTS) as never };
  const log = fromV1({ session_id: 'sess-tc', root_id: SID, rows: [row] });
  return new Map(log.threads[0]!.messages[0]!.blocks.map((b) => [b.id, b as ToolCallBlock]));
}

describe('toolCallBlock: the session-log block of a v1 tool part', () => {
  test('maps the call, its input, status and result; an open call stays open', () => {
    expect(toolCallBlock(PARTS.bash!)).toMatchObject({
      type: 'tool_call', id: 'prt_bash', call_id: 'call_prt_bash', name: 'bash', kind: 'shell', status: 'complete',
      input: { command: 'ls -la', description: 'Lists files' }, title: 'Lists files',
      result: { content: [{ type: 'text', text: 'a\nb\n' }], is_error: false, exit_code: 0 },
      started_at: new Date(T0).toISOString(), ended_at: new Date(T0 + 20).toISOString(),
    });
    expect(toolCallBlock(PARTS.task!)).toMatchObject({ status: 'running', kind: 'task', title: 'sub' });
    expect(toolCallBlock(PARTS.task!).result).toBeUndefined();
    expect(toolCallBlock(PARTS.pending!)).toMatchObject({ status: 'pending', input: {} });
    expect(toolCallBlock(PARTS.failed!)).toMatchObject({ status: 'error', result: { is_error: true, error: { message: 'File not found' } } });
  });

  test('one block per part object: the same part gives the same block, a replaced part a new one', () => {
    const a = toolCallBlock(PARTS.bash!);
    expect(toolCallBlock(PARTS.bash!)).toBe(a);
    expect(toolCallBlock({ ...PARTS.bash!, state: { ...PARTS.bash!.state } } as ToolPart)).not.toBe(a);
  });
});

describe('toolCallMetadata: the full state.metadata of the v1 part', () => {
  for (const name of ['bash', 'read', 'edit', 'task', 'question', 'todoread'] as const) {
    test(`${name}: live and at rest`, () => {
      const metadata = (PARTS[name]!.state as { metadata: unknown }).metadata;
      expect(toolCallMetadata(toolCallBlock(PARTS[name]!))).toEqual(metadata as never);
      expect(toolCallMetadata(atRest().get(PARTS[name]!.id)!)).toEqual(metadata as never);
    });
  }

  test('a call without metadata reads one shared empty object; a call keeps one metadata object', () => {
    const empty = toolCallMetadata(toolCallBlock(PARTS.pending!));
    expect(empty).toEqual({});
    expect(toolCallMetadata(toolCallBlock(PARTS.failed!))).toBe(empty);
    const block = toolCallBlock(PARTS.bash!);
    expect(toolCallMetadata(block)).toBe(toolCallMetadata(block));
  });

  test('a native record (no v1 residual) has only the metadata the block maps', () => {
    const native: ToolCallBlock = { type: 'tool_call', id: 'b1', call_id: 'c1', name: 'bash', kind: 'shell', input: { command: 'ls' }, status: 'complete', result: { content: [{ type: 'text', text: 'a' }], is_error: false, exit_code: 2 } };
    expect(toolCallMetadata(native)).toEqual({ exit: 2 });
  });
});

describe('the part helpers read a block the way they read its part', () => {
  const each = Object.values(PARTS);

  test('toToolView', () => {
    for (const p of each) expect(toToolView(toolCallBlock(p))).toEqual(toToolView(p));
  });

  test('getChildSessionId: a running task names its child', () => {
    expect(getChildSessionId(toolCallBlock(PARTS.task!))).toBe(CHILD);
    for (const p of each) expect(getChildSessionId(toolCallBlock(p))).toBe(getChildSessionId(p));
  });

  test('partOutcome', () => {
    for (const p of each) expect(partOutcome(toolCallBlock(p))).toEqual(partOutcome(p));
  });

  test('contextToolTrigger', () => {
    for (const p of each) expect(contextToolTrigger(toolCallBlock(p))).toEqual(contextToolTrigger(p));
  });

  test('shouldShowToolPart', () => {
    expect(shouldShowToolPart(toolCallBlock(PARTS.todoread!))).toBe(false);
    for (const p of each) expect(shouldShowToolPart(toolCallBlock(p))).toBe(shouldShowToolPart(p));
  });
});
