import { describe, expect, test } from 'bun:test';
import { followUpRoute } from './threads';

// A reply runs in the session its thread maps to, in that session's project.

describe('followUpRoute', () => {
  test('a new thread, or a thread of the resolved project, runs here', () => {
    expect(followUpRoute(null, 'proj-1')).toEqual({ kind: 'here' });
    expect(followUpRoute('proj-1', 'proj-1', { ownThreadsOnly: true })).toEqual({ kind: 'here' });
  });

  test("a thread of another project runs in that project's session", () => {
    expect(followUpRoute('proj-0', 'proj-1')).toEqual({ kind: 'thread_project', projectId: 'proj-0' });
  });

  test('a per-project app refuses a thread of another project', () => {
    expect(followUpRoute('proj-0', 'proj-1', { ownThreadsOnly: true })).toEqual({ kind: 'refused' });
  });
});
