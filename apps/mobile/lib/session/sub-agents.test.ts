import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@/lib/projects/projects-client';
import { parentSessionOf, subAgentRelation, subAgentsOf } from './sub-agents';

function session(id: string, overrides: Partial<ProjectSession> & { parent?: string } = {}): ProjectSession {
  const { parent, ...rest } = overrides;
  return {
    session_id: id,
    project_id: 'p1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    custom_name: null,
    name: id,
    branch_name: null,
    metadata: parent ? { spawned_by_session: parent } : null,
    opencode_sessions: [],
    ...rest,
  } as unknown as ProjectSession;
}

describe('parentSessionOf', () => {
  test('null when the session was not spawned by another session', () => {
    expect(parentSessionOf(session('root'), [])).toBeNull();
  });

  test('null when the session is missing', () => {
    expect(parentSessionOf(null, [session('root')])).toBeNull();
    expect(parentSessionOf(undefined, [session('root')])).toBeNull();
  });

  test('null when the parent is not in the project session list (deleted, not loaded)', () => {
    const child = session('child', { parent: 'missing' });
    expect(parentSessionOf(child, [child])).toBeNull();
  });

  test('null when the session names itself as its parent (sessionParentId rejects it)', () => {
    const self = session('self', { parent: 'self' });
    expect(parentSessionOf(self, [self])).toBeNull();
  });

  test('resolves metadata.spawned_by_session against the project session rows', () => {
    const root = session('root');
    const child = session('child', { parent: 'root' });
    expect(parentSessionOf(child, [root, child])?.session_id).toBe('root');
  });
});

describe('subAgentsOf', () => {
  test('empty when no session was spawned by this one', () => {
    expect(subAgentsOf('root', [session('root')])).toEqual([]);
  });

  test('direct children only, newest activity first', () => {
    const root = session('root');
    const older = session('a', { parent: 'root', updated_at: '2026-01-02T00:00:00.000Z' });
    const newer = session('b', { parent: 'root', updated_at: '2026-01-03T00:00:00.000Z' });
    const grandchild = session('c', { parent: 'a', updated_at: '2026-01-04T00:00:00.000Z' });
    expect(subAgentsOf('root', [root, older, newer, grandchild]).map((s) => s.session_id)).toEqual(['b', 'a']);
  });

  test('ties on activity break on session_id for a stable order', () => {
    const root = session('root');
    const b = session('b', { parent: 'root' });
    const a = session('a', { parent: 'root' });
    expect(subAgentsOf('root', [root, b, a]).map((s) => s.session_id)).toEqual(['a', 'b']);
  });
});

describe('subAgentRelation', () => {
  test('null for a session with no parent and no sub-agents', () => {
    const solo = session('solo');
    expect(subAgentRelation(solo, [solo])).toBeNull();
    expect(subAgentRelation(null, [solo])).toBeNull();
  });

  test('"child" carries the parent row and its display title', () => {
    const root = session('root', { custom_name: 'Research plan' });
    const child = session('child', { parent: 'root' });
    expect(subAgentRelation(child, [root, child])).toEqual({
      type: 'child',
      parent: root,
      parentTitle: 'Research plan',
    });
  });

  test('"parent" when the session spawned sub-agents and has no parent of its own', () => {
    const root = session('root');
    const a = session('a', { parent: 'root' });
    const b = session('b', { parent: 'root' });
    expect(subAgentRelation(root, [root, a, b])).toEqual({ type: 'parent', count: 2 });
  });

  test('a resolvable parent wins over the session also having sub-agents', () => {
    const root = session('root');
    const mid = session('mid', { parent: 'root' });
    const leaf = session('leaf', { parent: 'mid' });
    expect(subAgentRelation(mid, [root, mid, leaf])?.type).toBe('child');
  });

  test('an unresolved parent falls through to the sub-agent count', () => {
    const orphan = session('orphan', { parent: 'missing' });
    const kid = session('kid', { parent: 'orphan' });
    expect(subAgentRelation(orphan, [orphan])).toBeNull();
    expect(subAgentRelation(orphan, [orphan, kid])).toEqual({ type: 'parent', count: 1 });
  });

  test('the same relation the session list nests by: an OpenCode sub-session is not a sub-agent', () => {
    // `opencode_sessions[].parent_id` is OpenCode's own tree. Neither the list
    // nor the header reads it.
    const root = session('root', {
      opencode_sessions: [
        { id: 'oc-1', parent_id: null },
        { id: 'oc-2', parent_id: 'oc-1' },
      ],
    } as never);
    expect(subAgentRelation(root, [root])).toBeNull();
  });
});
