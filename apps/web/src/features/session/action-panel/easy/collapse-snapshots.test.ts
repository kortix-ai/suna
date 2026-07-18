import { describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import { collapseSnapshots } from './detail-view';

function part(tool: string, id: string): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: id,
    state: { status: 'completed', input: {} },
  } as unknown as ToolPart;
}

describe('collapseSnapshots', () => {
  it('keeps only the LAST todo_write — each call is a full snapshot, not a delta', () => {
    const kept = collapseSnapshots([
      part('todo_write', 'a'),
      part('todo_write', 'b'),
      part('todo_write', 'c'),
    ]);
    expect(kept.map((p) => p.callID)).toEqual(['c']);
  });

  it('normalizes aliases (todowrite, oc- prefix, kebab-case)', () => {
    const kept = collapseSnapshots([
      part('oc-todo-write', 'a'),
      part('todowrite', 'b'),
      part('todo_write', 'c'),
    ]);
    expect(kept.map((p) => p.callID)).toEqual(['c']);
  });

  it('leaves non-snapshot calls alone — each is a real distinct event', () => {
    const kept = collapseSnapshots([part('bash', 'a'), part('bash', 'b')]);
    expect(kept.map((p) => p.callID)).toEqual(['a', 'b']);
  });

  it('keeps other calls around the surviving snapshot, in order', () => {
    const kept = collapseSnapshots([
      part('todo_write', 'snap1'),
      part('bash', 'cmd'),
      part('todo_write', 'snap2'),
      part('read', 'file'),
    ]);
    expect(kept.map((p) => p.callID)).toEqual(['cmd', 'snap2', 'file']);
  });

  it('is a no-op for a single snapshot', () => {
    const kept = collapseSnapshots([part('todo_write', 'only')]);
    expect(kept.map((p) => p.callID)).toEqual(['only']);
  });

  it('handles an empty list', () => {
    expect(collapseSnapshots([])).toEqual([]);
  });
});
