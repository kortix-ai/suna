import { describe, expect, test } from 'bun:test';
import type { ProjectRuntimeSession, ProjectSession } from '../rest/projects-client/sessions';
import {
  directSubsessions,
  projectSessionForRuntimeId,
  rootRuntimeSession,
  runtimeSessionsOf,
} from './runtime-sessions';

const conv = (id: string, extra: Partial<ProjectRuntimeSession> = {}): ProjectRuntimeSession => ({
  id,
  title: null,
  parent_id: null,
  project_id: null,
  created_at: null,
  updated_at: null,
  archived_at: null,
  ...extra,
});

const session = (fields: Partial<ProjectSession>): ProjectSession =>
  ({ session_id: 's1', opencode_session_id: null, opencode_sessions: [], ...fields }) as ProjectSession;

describe('runtimeSessionsOf', () => {
  test('reads runtime_sessions first, then the pre-W4 opencode_sessions', () => {
    expect(runtimeSessionsOf(session({ runtime_sessions: [conv('new')], opencode_sessions: [conv('old')] })).map((s) => s.id)).toEqual(['new']);
    expect(runtimeSessionsOf(session({ opencode_sessions: [conv('old')] })).map((s) => s.id)).toEqual(['old']);
    expect(runtimeSessionsOf(session({ opencode_sessions: undefined as never }))).toEqual([]);
  });
});

describe('rootRuntimeSession', () => {
  test('the pinned root, by runtime_session_id first', () => {
    const s = session({
      runtime_session_id: 'r2',
      opencode_session_id: 'r1',
      runtime_sessions: [conv('r1'), conv('r2')],
    });
    expect(rootRuntimeSession(s)?.id).toBe('r2');
    expect(rootRuntimeSession(session({ opencode_session_id: 'r1', opencode_sessions: [conv('r1')] }))?.id).toBe('r1');
  });

  test('a pin missing from the list is null; no pin takes the first parentless entry', () => {
    expect(rootRuntimeSession(session({ runtime_session_id: 'gone', runtime_sessions: [conv('r1')] }))).toBeNull();
    expect(
      rootRuntimeSession(session({ runtime_sessions: [conv('c1', { parent_id: 'r1' }), conv('r1')] }))?.id,
    ).toBe('r1');
  });
});

describe('directSubsessions', () => {
  const parent = (children: Array<Partial<ProjectRuntimeSession> & { id: string }>) =>
    session({
      runtime_session_id: 'root',
      runtime_sessions: [conv('root'), ...children.map((c) => conv(c.id, { parent_id: 'root', ...c }))],
    });

  test('newest first; ties and missing times order by id', () => {
    expect(directSubsessions(parent([{ id: 'a', updated_at: 100 }, { id: 'b', updated_at: 300 }, { id: 'c', updated_at: 200 }])).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(directSubsessions(parent([{ id: 'c' }, { id: 'a' }, { id: 'b' }])).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(directSubsessions(parent([{ id: 'z', updated_at: 5 }, { id: 'y', updated_at: 5 }])).map((s) => s.id)).toEqual(['y', 'z']);
  });

  test('skips archived children and grandchildren', () => {
    const s = parent([{ id: 'a' }, { id: 'gone', archived_at: 1 }]);
    s.runtime_sessions!.push(conv('grand', { parent_id: 'a' }));
    expect(directSubsessions(s).map((c) => c.id)).toEqual(['a']);
  });

  test('no root, no children', () => {
    expect(directSubsessions(session({}))).toEqual([]);
  });
});

describe('projectSessionForRuntimeId', () => {
  const a = session({ session_id: 'A', runtime_session_id: 'rootA', runtime_sessions: [conv('rootA'), conv('childA', { parent_id: 'rootA' })] });
  const b = session({ session_id: 'B', opencode_session_id: 'rootB', opencode_sessions: [conv('rootB')] });

  test('a session id or root pin, then any conversation of a row', () => {
    expect(projectSessionForRuntimeId([a, b], 'A')?.session_id).toBe('A');
    expect(projectSessionForRuntimeId([a, b], 'rootB')?.session_id).toBe('B');
    expect(projectSessionForRuntimeId([a, b], 'childA')?.session_id).toBe('A');
  });

  test('null for null or an unknown id', () => {
    expect(projectSessionForRuntimeId([a, b], null)).toBeNull();
    expect(projectSessionForRuntimeId([a, b], 'nope')).toBeNull();
  });
});
