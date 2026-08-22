import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';
import {
  getSessionDisplayTitle,
  groupSessionsByCoordinator,
  projectSessionsRefetchInterval,
  resolveSessionListViewState,
  sessionLastActivityAt,
  shortRelative,
  shouldPollProjectSessions,
  sortSessionsByLastActivity,
} from './project-session-list-helpers';

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 's1',
    project_id: 'p1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
    custom_name: null,
    name: null,
    branch_name: null,
    metadata: null,
    ...overrides,
  } as unknown as ProjectSession;
}

describe('shouldPollProjectSessions', () => {
  test('polls when a session is queued', () => {
    expect(shouldPollProjectSessions([makeSession({ status: 'queued' })])).toBe(true);
  });

  test('polls when a session is branching', () => {
    expect(shouldPollProjectSessions([makeSession({ status: 'branching' })])).toBe(true);
  });

  test('polls when a session is provisioning', () => {
    expect(shouldPollProjectSessions([makeSession({ status: 'provisioning' })])).toBe(true);
  });

  test('does not poll when every session has settled', () => {
    const sessions = [
      makeSession({ status: 'running' }),
      makeSession({ status: 'stopped' }),
      makeSession({ status: 'completed' }),
    ];
    expect(shouldPollProjectSessions(sessions)).toBe(false);
  });

  test('does not poll an empty or undefined list', () => {
    expect(shouldPollProjectSessions([])).toBe(false);
    expect(shouldPollProjectSessions(undefined)).toBe(false);
  });
});

describe('projectSessionsRefetchInterval', () => {
  // `name` is part of being settled, not decoration. A session whose title the
  // server has not written yet is still waiting on something, and gets the
  // pending-title poll — see `session-title-convergence.test.ts`. Leaving this
  // fixture nameless made "settled" mean two different things in one file.
  const settled = [makeSession({ status: 'running', name: 'Titled Session' })];

  test('provisioning polls fast, and outranks the open-session interval', () => {
    const sessions = [makeSession({ status: 'provisioning' })];
    expect(projectSessionsRefetchInterval({ sessions, hasOpenSession: false })).toBe(5_000);
    expect(projectSessionsRefetchInterval({ sessions, hasOpenSession: true })).toBe(5_000);
  });

  test('an open session polls slowly so its row can change section as it is used', () => {
    expect(projectSessionsRefetchInterval({ sessions: settled, hasOpenSession: true })).toBe(
      60_000,
    );
  });

  test('a project page with no session open does not poll', () => {
    expect(projectSessionsRefetchInterval({ sessions: settled, hasOpenSession: false })).toBe(
      false,
    );
    expect(projectSessionsRefetchInterval({ sessions: undefined, hasOpenSession: false })).toBe(
      false,
    );
  });
});

function openCodeSession(updatedAt: string | null, id = 'oc-1') {
  return {
    id,
    title: null,
    parent_id: null,
    project_id: null,
    created_at: null,
    updated_at: updatedAt === null ? null : Date.parse(updatedAt),
    archived_at: null,
  };
}

describe('session last activity', () => {
  test('uses the latest OpenCode conversation activity, not row bookkeeping', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-08T08:00:09.000Z',
      opencode_sessions: [openCodeSession('2026-01-03T04:05:06.000Z')],
    });

    expect(sessionLastActivityAt(session)).toBe('2026-01-03T04:05:06.000Z');
  });

  test("the API's prompt stamp counts as activity", () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata: { last_activity_at: '2026-01-09T10:00:00.000Z' },
      opencode_sessions: [],
    });

    expect(sessionLastActivityAt(session)).toBe('2026-01-09T10:00:00.000Z');
  });

  test('the newer of the prompt stamp and the conversation snapshot wins', () => {
    const staleSnapshot = makeSession({
      metadata: { last_activity_at: '2026-01-09T10:00:00.000Z' },
      opencode_sessions: [openCodeSession('2026-01-02T00:00:00.000Z')],
    });
    // The agent keeps replying after the prompt was stamped, so the snapshot
    // legitimately leads the stamp.
    const stalePrompt = makeSession({
      metadata: { last_activity_at: '2026-01-09T10:00:00.000Z' },
      opencode_sessions: [openCodeSession('2026-01-09T10:04:00.000Z')],
    });

    expect(sessionLastActivityAt(staleSnapshot)).toBe('2026-01-09T10:00:00.000Z');
    expect(sessionLastActivityAt(stalePrompt)).toBe('2026-01-09T10:04:00.000Z');
  });

  test('a malformed stamp is ignored, not treated as activity', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata: { last_activity_at: 'not a date' },
      opencode_sessions: [openCodeSession('2026-01-03T00:00:00.000Z')],
    });

    expect(sessionLastActivityAt(session)).toBe('2026-01-03T00:00:00.000Z');
  });

  test('a snapshot entry with no timestamp does not mask a later one', () => {
    const session = makeSession({
      opencode_sessions: [
        openCodeSession(null, 'oc-a'),
        openCodeSession('2026-01-05T00:00:00.000Z', 'oc-b'),
      ],
    });

    expect(sessionLastActivityAt(session)).toBe('2026-01-05T00:00:00.000Z');
  });

  // The reported bug: a session with no activity record at all was pinned to
  // its creation date, so one used every day never left "Older".
  test('with no activity signal at all, updated_at beats created_at', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-08T08:00:09.000Z',
      opencode_sessions: [],
    });

    expect(sessionLastActivityAt(session)).toBe('2026-01-08T08:00:09.000Z');
  });

  test('created_at is the last resort when the row carries no updated_at', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: undefined,
      opencode_sessions: [],
    });

    expect(sessionLastActivityAt(session)).toBe('2026-01-01T00:00:00.000Z');
  });

  // Guards the rule that survives from #6039: bookkeeping (runtime stop/resume,
  // title sync, mapping repair) must never outrank real conversation activity.
  test('row bookkeeping never outranks a session that has real activity', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-20T00:00:00.000Z',
      opencode_sessions: [openCodeSession('2026-01-03T00:00:00.000Z')],
    });

    expect(sessionLastActivityAt(session)).toBe('2026-01-03T00:00:00.000Z');
  });

  test('orders reused sessions by latest activity, not by row bookkeeping', () => {
    // Every row's `updated_at` is deliberately in the opposite order to its
    // real activity: sorting on bookkeeping would return ['a', 'b', 'c'].
    const oldest = makeSession({
      session_id: 'a',
      created_at: '2026-01-03T00:00:00.000Z',
      updated_at: '2026-01-20T00:00:00.000Z',
      opencode_sessions: [openCodeSession('2026-01-04T00:00:00.000Z', 'oc-a')],
    });
    const middle = makeSession({
      session_id: 'b',
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-19T00:00:00.000Z',
      opencode_sessions: [openCodeSession('2026-01-05T00:00:00.000Z', 'oc-b')],
    });
    const newest = makeSession({
      session_id: 'c',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-18T00:00:00.000Z',
      metadata: { last_activity_at: '2026-01-06T00:00:00.000Z' },
      opencode_sessions: [],
    });

    const result = sortSessionsByLastActivity([oldest, newest, middle]);

    expect(result.map((s) => s.session_id)).toEqual(['c', 'b', 'a']);
  });

  test('does not mutate the input array', () => {
    const input = [
      makeSession({ session_id: 'a', created_at: '2026-01-01T00:00:00.000Z' }),
      makeSession({ session_id: 'b', created_at: '2026-01-02T00:00:00.000Z' }),
    ];
    const inputCopy = [...input];

    sortSessionsByLastActivity(input);

    expect(input).toEqual(inputCopy);
  });

  test('an empty list sorts to an empty list', () => {
    expect(sortSessionsByLastActivity([])).toEqual([]);
  });
});

describe('getSessionDisplayTitle', () => {
  test('a user rename (custom_name) wins over everything else', () => {
    const session = makeSession({
      custom_name: 'My renamed session',
      name: 'server-name',
      branch_name: 'feature/branch-name',
    });
    expect(getSessionDisplayTitle(session)).toBe('My renamed session');
  });

  test('falls back to the server name when there is no custom name', () => {
    const session = makeSession({ name: 'server-name', branch_name: 'feature/branch-name' });
    expect(getSessionDisplayTitle(session)).toBe('server-name');
  });

  test('falls back to legacy metadata.session_name next', () => {
    const session = makeSession({
      metadata: { session_name: 'legacy-name' },
      branch_name: 'feature/branch-name',
    });
    expect(getSessionDisplayTitle(session)).toBe('legacy-name');
  });

  test('untitled sessions fall back to a humane static label, never branch hex', () => {
    const session = makeSession({ branch_name: 'feature/a-very-long-branch-name' });
    expect(getSessionDisplayTitle(session)).toBe('New session');
    expect(getSessionDisplayTitle(makeSession())).toBe('New session');
  });

  test('blank/whitespace-only names are treated as absent', () => {
    const session = makeSession({ custom_name: '   ', name: 'server-name' });
    expect(getSessionDisplayTitle(session)).toBe('server-name');
  });
});

describe('shortRelative', () => {
  test('collapses "less than a minute" to "now"', () => {
    expect(shortRelative('less than a minute')).toBe('now');
  });

  test('collapses "0 seconds" to "now"', () => {
    expect(shortRelative('0 seconds')).toBe('now');
  });

  test('compresses each unit to its single-letter suffix', () => {
    expect(shortRelative('5 seconds')).toBe('5s');
    expect(shortRelative('5 minutes')).toBe('5m');
    expect(shortRelative('5 hours')).toBe('5h');
    expect(shortRelative('5 days')).toBe('5d');
    expect(shortRelative('5 months')).toBe('5mo');
    expect(shortRelative('5 years')).toBe('5y');
  });

  test('handles the singular form (no trailing "s")', () => {
    expect(shortRelative('1 minute')).toBe('1m');
  });

  test('passes unrecognized input through unchanged', () => {
    expect(shortRelative('a while ago')).toBe('a while ago');
  });
});

describe('resolveSessionListViewState', () => {
  test('loading wins regardless of error or counts', () => {
    const state = resolveSessionListViewState({
      isLoading: true,
      isError: true,
      totalCount: 5,
      visibleCount: 5,
    });
    expect(state).toBe('loading');
  });

  test('error wins over empty/no-matches once loading has settled', () => {
    const state = resolveSessionListViewState({
      isLoading: false,
      isError: true,
      totalCount: 0,
      visibleCount: 0,
    });
    expect(state).toBe('error');
  });

  test('no sessions at all is "empty"', () => {
    const state = resolveSessionListViewState({
      isLoading: false,
      isError: false,
      totalCount: 0,
      visibleCount: 0,
    });
    expect(state).toBe('empty');
  });

  test('sessions exist but the active filter matches none: "no-matches"', () => {
    const state = resolveSessionListViewState({
      isLoading: false,
      isError: false,
      totalCount: 3,
      visibleCount: 0,
    });
    expect(state).toBe('no-matches');
  });

  test('sessions exist and the filter matches some: "content"', () => {
    const state = resolveSessionListViewState({
      isLoading: false,
      isError: false,
      totalCount: 3,
      visibleCount: 2,
    });
    expect(state).toBe('content');
  });
});

describe('groupSessionsByCoordinator', () => {
  const meta = makeSession({ session_id: 'meta-1', agent_name: 'meta' } as never);
  const childA = makeSession({
    session_id: 'child-a',
    metadata: { spawned_by_session: 'meta-1' },
  } as never);
  const childB = makeSession({
    session_id: 'child-b',
    metadata: { spawned_by_session: 'meta-1' },
  } as never);
  const solo = makeSession({ session_id: 'solo-1' });
  const orphan = makeSession({
    session_id: 'orphan-1',
    metadata: { spawned_by_session: 'gone-1' },
  } as never);

  test('nests children under their coordinator, in list order', () => {
    const groups = groupSessionsByCoordinator([meta, childA, solo, childB]);
    expect(groups.map((g) => g.session.session_id)).toEqual(['meta-1', 'solo-1']);
    expect(groups[0].children.map((c) => c.session_id)).toEqual(['child-a', 'child-b']);
    expect(groups[1].children).toEqual([]);
  });

  test('a child whose coordinator is not in the list renders top-level', () => {
    const groups = groupSessionsByCoordinator([orphan, solo]);
    expect(groups.map((g) => g.session.session_id)).toEqual(['orphan-1', 'solo-1']);
  });
});
