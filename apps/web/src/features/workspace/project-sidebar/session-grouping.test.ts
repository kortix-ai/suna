import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';
import { groupSessions } from './session-grouping';

const NOW = new Date('2026-08-06T12:00:00.000Z').getTime();

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 's1',
    project_id: 'p1',
    status: 'running',
    created_at: '2026-08-06T11:00:00.000Z',
    custom_name: null,
    name: null,
    branch_name: null,
    metadata: null,
    opencode_sessions: [],
    ...overrides,
  } as unknown as ProjectSession;
}

describe('groupSessions — status mode', () => {
  test('orders sections needs-you, running, recent', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'done', status: 'completed' }),
        makeSession({ session_id: 'run', status: 'running' }),
        makeSession({ session_id: 'rev', status: 'completed' }),
      ],
      { mode: 'status', order: 'activity', reviewCountBySession: { rev: 1 }, now: NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['needs-you', 'running', 'recent']);
  });

  test('a review-pending session appears exactly once', () => {
    const grouped = groupSessions([makeSession({ session_id: 'run', status: 'running' })], {
      mode: 'status', order: 'activity', reviewCountBySession: { run: 2 }, now: NOW,
    });
    expect(grouped.sections.flatMap((s) => s.sessions.map((x) => x.session_id))).toEqual(['run']);
  });
});

describe('groupSessions — activity mode', () => {
  test('buckets by age against the injected now', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'a', created_at: '2026-08-06T09:00:00.000Z' }),
        makeSession({ session_id: 'b', created_at: '2026-08-05T09:00:00.000Z' }),
        makeSession({ session_id: 'c', created_at: '2026-08-02T09:00:00.000Z' }),
        makeSession({ session_id: 'd', created_at: '2026-06-01T09:00:00.000Z' }),
      ],
      { mode: 'activity', order: 'activity', reviewCountBySession: {}, now: NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today', 'yesterday', 'week', 'older']);
  });

  test('review state does not move a session out of its date bucket', () => {
    const grouped = groupSessions(
      [makeSession({ session_id: 'a', created_at: '2026-08-06T09:00:00.000Z' })],
      { mode: 'activity', order: 'activity', reviewCountBySession: { a: 3 }, now: NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today']);
  });
});

describe('groupSessions — source mode', () => {
  test('groups by source kind, omitting absent kinds', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'a' }),
        makeSession({ session_id: 'b', metadata: { source: 'slack' } }),
      ],
      { mode: 'source', order: 'activity', reviewCountBySession: {}, now: NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['chat', 'slack']);
  });
});

describe('groupSessions — none mode', () => {
  test('one section, no headers', () => {
    const grouped = groupSessions([makeSession(), makeSession({ session_id: 's2' })], {
      mode: 'none', order: 'activity', reviewCountBySession: {}, now: NOW,
    });
    expect(grouped.sections.map((s) => s.id)).toEqual(['all']);
    expect(grouped.showHeaders).toBe(false);
  });
});

describe('groupSessions — ordering', () => {
  const older = makeSession({ session_id: 'older', name: 'Zebra', created_at: '2026-08-01T00:00:00.000Z' });
  const newer = makeSession({ session_id: 'newer', name: 'Alpha', created_at: '2026-08-05T00:00:00.000Z' });

  test('created sorts newest first', () => {
    const grouped = groupSessions([older, newer], {
      mode: 'none', order: 'created', reviewCountBySession: {}, now: NOW,
    });
    expect(grouped.sections[0].sessions.map((s) => s.session_id)).toEqual(['newer', 'older']);
  });

  test('name sorts A to Z, case-insensitively', () => {
    const grouped = groupSessions([older, newer], {
      mode: 'none', order: 'name', reviewCountBySession: {}, now: NOW,
    });
    expect(grouped.sections[0].sessions.map((s) => s.session_id)).toEqual(['newer', 'older']);
  });
});

describe('groupSessions — hidden sections and invariants', () => {
  test('a hidden section is dropped entirely', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'run', status: 'running' }),
        makeSession({ session_id: 'done', status: 'completed' }),
      ],
      { mode: 'status', order: 'activity', reviewCountBySession: {}, hiddenSections: ['running'], now: NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['recent']);
  });

  test('showHeaders is false at one or zero populated sections', () => {
    const one = groupSessions([makeSession({ status: 'completed' })], {
      mode: 'status', order: 'activity', reviewCountBySession: {}, now: NOW,
    });
    expect(one.showHeaders).toBe(false);
    const none = groupSessions([], { mode: 'status', order: 'activity', reviewCountBySession: {}, now: NOW });
    expect(none.sections).toEqual([]);
    expect(none.showHeaders).toBe(false);
  });

  test('open-ended tails carry no count', () => {
    const grouped = groupSessions(
      [makeSession({ session_id: 'run', status: 'running' }), makeSession({ session_id: 'd', status: 'completed' })],
      { mode: 'status', order: 'activity', reviewCountBySession: {}, now: NOW },
    );
    const byId = Object.fromEntries(grouped.sections.map((s) => [s.id, s.showCount]));
    expect(byId.running).toBe(true);
    expect(byId.recent).toBe(false);
  });

  test('does not mutate the input array', () => {
    const input = [makeSession({ session_id: 'a' }), makeSession({ session_id: 'b' })];
    groupSessions(input, { mode: 'status', order: 'name', reviewCountBySession: {}, now: NOW });
    expect(input.map((s) => s.session_id)).toEqual(['a', 'b']);
  });
});
