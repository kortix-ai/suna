import { describe, expect, test } from 'bun:test';

import {
  getSessionDisplayTitle,
  resolveSessionListViewState,
  shortRelative,
  shouldPollProjectSessions,
  sortSessionsByCreatedAt,
} from './project-session-list-helpers';
import type { ProjectSession } from '@kortix/sdk/projects-client';

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

describe('sortSessionsByCreatedAt', () => {
  test('orders sessions newest-first', () => {
    const oldest = makeSession({ session_id: 'a', created_at: '2026-01-01T00:00:00.000Z' });
    const middle = makeSession({ session_id: 'b', created_at: '2026-01-02T00:00:00.000Z' });
    const newest = makeSession({ session_id: 'c', created_at: '2026-01-03T00:00:00.000Z' });

    const result = sortSessionsByCreatedAt([oldest, newest, middle]);

    expect(result.map((s) => s.session_id)).toEqual(['c', 'b', 'a']);
  });

  test('does not mutate the input array', () => {
    const input = [
      makeSession({ session_id: 'a', created_at: '2026-01-01T00:00:00.000Z' }),
      makeSession({ session_id: 'b', created_at: '2026-01-02T00:00:00.000Z' }),
    ];
    const inputCopy = [...input];

    sortSessionsByCreatedAt(input);

    expect(input).toEqual(inputCopy);
  });

  test('an empty list sorts to an empty list', () => {
    expect(sortSessionsByCreatedAt([])).toEqual([]);
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
