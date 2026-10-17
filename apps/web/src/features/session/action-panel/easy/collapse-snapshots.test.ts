import type { ToolPart } from '@/ui';
import { toolCallBlock, type ToolCallBlock } from '@kortix/sdk';
import { describe, expect, it } from 'bun:test';
import { collapseSnapshots } from './detail-view';

function part(tool: string, id: string): ToolCallBlock {
  return toolCallBlock({
    type: 'tool',
    tool,
    callID: id,
    state: { status: 'completed', input: {} },
  } as unknown as ToolPart);
}

describe('collapseSnapshots', () => {
  it('keeps only the LAST todo_write — each call is a full snapshot, not a delta', () => {
    const kept = collapseSnapshots([
      part('todo_write', 'a'),
      part('todo_write', 'b'),
      part('todo_write', 'c'),
    ]);
    expect(kept.map((c) => c.call_id)).toEqual(['c']);
  });

  it('normalizes aliases (todowrite, oc- prefix, kebab-case)', () => {
    const kept = collapseSnapshots([
      part('oc-todo-write', 'a'),
      part('todowrite', 'b'),
      part('todo_write', 'c'),
    ]);
    expect(kept.map((c) => c.call_id)).toEqual(['c']);
  });

  it('leaves non-snapshot calls alone — each is a real distinct event', () => {
    const kept = collapseSnapshots([part('bash', 'a'), part('bash', 'b')]);
    expect(kept.map((c) => c.call_id)).toEqual(['a', 'b']);
  });

  it('keeps other calls around the surviving snapshot, in order', () => {
    const kept = collapseSnapshots([
      part('todo_write', 'snap1'),
      part('bash', 'cmd'),
      part('todo_write', 'snap2'),
      part('read', 'file'),
    ]);
    expect(kept.map((c) => c.call_id)).toEqual(['cmd', 'snap2', 'file']);
  });

  it('is a no-op for a single snapshot', () => {
    const kept = collapseSnapshots([part('todo_write', 'only')]);
    expect(kept.map((c) => c.call_id)).toEqual(['only']);
  });

  it('handles an empty list', () => {
    expect(collapseSnapshots([])).toEqual([]);
  });
});
