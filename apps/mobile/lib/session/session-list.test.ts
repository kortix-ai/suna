import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  filterSessionsByTitle,
  groupSessionsByActivity,
  recentSessions,
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionLastActivityAt,
  sessionStatusLabel,
  shortRelative,
  spokenRelative,
} from './session-list';

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 's1',
    project_id: 'p1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    custom_name: null,
    name: null,
    branch_name: null,
    metadata: null,
    opencode_sessions: [],
    ...overrides,
  } as unknown as ProjectSession;
}

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

describe('sessionDisplayTitle', () => {
  test('a user rename (custom_name) wins over everything else', () => {
    const session = makeSession({
      custom_name: 'My renamed session',
      name: 'server-name',
      branch_name: 'feature/branch-name',
    });
    expect(sessionDisplayTitle(session)).toBe('My renamed session');
  });

  test('falls back to the server name when there is no custom name', () => {
    const session = makeSession({ name: 'server-name', branch_name: 'feature/branch-name' });
    expect(sessionDisplayTitle(session)).toBe('server-name');
  });

  test('falls back to legacy metadata.session_name next', () => {
    const session = makeSession({
      metadata: { session_name: 'legacy-name' },
      branch_name: 'feature/branch-name',
    });
    expect(sessionDisplayTitle(session)).toBe('legacy-name');
  });

  test('untitled sessions fall back to "New session"', () => {
    expect(sessionDisplayTitle(makeSession({ branch_name: 'feature/a-very-long-branch' }))).toBe(
      'New session',
    );
    expect(sessionDisplayTitle(makeSession())).toBe('New session');
  });

  test('blank/whitespace-only names are treated as absent', () => {
    const session = makeSession({ custom_name: '   ', name: 'server-name' });
    expect(sessionDisplayTitle(session)).toBe('server-name');
  });

  test('blank metadata.session_name falls through to the placeholder', () => {
    const session = makeSession({ metadata: { session_name: '   ' } });
    expect(sessionDisplayTitle(session)).toBe('New session');
  });
});

describe('sessionDisplayStatus', () => {
  test('queued / branching / provisioning collapse to starting', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'queued' }))).toBe('starting');
    expect(sessionDisplayStatus(makeSession({ status: 'branching' }))).toBe('starting');
    expect(sessionDisplayStatus(makeSession({ status: 'provisioning' }))).toBe('starting');
  });

  test('running stays running', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'running' }))).toBe('running');
  });

  test('stopped and completed both collapse to stopped', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'stopped' }))).toBe('stopped');
    expect(sessionDisplayStatus(makeSession({ status: 'completed' }))).toBe('stopped');
  });

  test('failed stays failed', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'failed' }))).toBe('failed');
  });

  test('an unrecognized status falls back to stopped', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'weird' as never }))).toBe('stopped');
  });

  test('a pending review wins outright over every lifecycle status', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'running' }), 1)).toBe('needs-you');
    expect(sessionDisplayStatus(makeSession({ status: 'failed' }), 2)).toBe('needs-you');
    expect(sessionDisplayStatus(makeSession({ status: 'queued' }), 1)).toBe('needs-you');
  });

  test('a zero review count does not trigger needs-you', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'running' }), 0)).toBe('running');
  });

  test('review count defaults to zero when omitted', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'completed' }))).toBe('stopped');
  });
});

describe('sessionLastActivityAt', () => {
  test('uses the latest OpenCode conversation activity, not row bookkeeping', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-08T08:00:09.000Z',
      opencode_sessions: [openCodeSession('2026-01-03T04:05:06.000Z')],
    });
    expect(sessionLastActivityAt(session)).toBe(Date.parse('2026-01-03T04:05:06.000Z'));
  });

  test("the API's prompt stamp counts as activity", () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata: { last_activity_at: '2026-01-09T10:00:00.000Z' },
      opencode_sessions: [],
    });
    expect(sessionLastActivityAt(session)).toBe(Date.parse('2026-01-09T10:00:00.000Z'));
  });

  test('the newer of the prompt stamp and the conversation snapshot wins', () => {
    const staleSnapshot = makeSession({
      metadata: { last_activity_at: '2026-01-09T10:00:00.000Z' },
      opencode_sessions: [openCodeSession('2026-01-02T00:00:00.000Z')],
    });
    const stalePrompt = makeSession({
      metadata: { last_activity_at: '2026-01-09T10:00:00.000Z' },
      opencode_sessions: [openCodeSession('2026-01-09T10:04:00.000Z')],
    });
    expect(sessionLastActivityAt(staleSnapshot)).toBe(Date.parse('2026-01-09T10:00:00.000Z'));
    expect(sessionLastActivityAt(stalePrompt)).toBe(Date.parse('2026-01-09T10:04:00.000Z'));
  });

  test('a malformed stamp is ignored, not treated as activity', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata: { last_activity_at: 'not a date' },
      opencode_sessions: [openCodeSession('2026-01-03T00:00:00.000Z')],
    });
    expect(sessionLastActivityAt(session)).toBe(Date.parse('2026-01-03T00:00:00.000Z'));
  });

  test('a snapshot entry with no timestamp does not mask a later one', () => {
    const session = makeSession({
      opencode_sessions: [
        openCodeSession(null, 'oc-a'),
        openCodeSession('2026-01-05T00:00:00.000Z', 'oc-b'),
      ],
    });
    expect(sessionLastActivityAt(session)).toBe(Date.parse('2026-01-05T00:00:00.000Z'));
  });

  test('with no activity signal at all, updated_at beats created_at', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-08T08:00:09.000Z',
      opencode_sessions: [],
    });
    expect(sessionLastActivityAt(session)).toBe(Date.parse('2026-01-08T08:00:09.000Z'));
  });

  test('created_at is the last resort when the row carries no updated_at', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: undefined,
      opencode_sessions: [],
    });
    expect(sessionLastActivityAt(session)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  test('row bookkeeping never outranks a session that has real activity', () => {
    const session = makeSession({
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-20T00:00:00.000Z',
      opencode_sessions: [openCodeSession('2026-01-03T00:00:00.000Z')],
    });
    expect(sessionLastActivityAt(session)).toBe(Date.parse('2026-01-03T00:00:00.000Z'));
  });
});

describe('shortRelative', () => {
  const NOW = new Date(2026, 8, 16, 10, 0, 0).getTime();

  test('under a minute is "now"', () => {
    expect(shortRelative(NOW, NOW)).toBe('now');
    expect(shortRelative(NOW - 30_000, NOW)).toBe('now');
  });

  test('a future timestamp clamps to "now"', () => {
    expect(shortRelative(NOW + 60_000, NOW)).toBe('now');
  });

  test('minutes', () => {
    expect(shortRelative(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(shortRelative(NOW - 59 * 60_000, NOW)).toBe('59m');
  });

  test('hours', () => {
    expect(shortRelative(NOW - 2 * 60 * 60_000, NOW)).toBe('2h');
    expect(shortRelative(NOW - 23 * 60 * 60_000, NOW)).toBe('23h');
  });

  test('days', () => {
    expect(shortRelative(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe('3d');
    expect(shortRelative(NOW - 29 * 24 * 60 * 60_000, NOW)).toBe('29d');
  });

  test('months', () => {
    expect(shortRelative(NOW - 60 * 24 * 60 * 60_000, NOW)).toBe('2mo');
  });

  test('years', () => {
    expect(shortRelative(NOW - 400 * 24 * 60 * 60_000, NOW)).toBe('1y');
  });
});

describe('groupSessionsByActivity', () => {
  // Local-time constructors throughout, per the task brief, so bucket tests
  // do not depend on the machine's timezone.
  const NOW = new Date(2026, 8, 16, 10, 0, 0).getTime();

  test('buckets today / yesterday / week / older against the injected now', () => {
    const grouped = groupSessionsByActivity(
      [
        makeSession({ session_id: 'today', updated_at: new Date(2026, 8, 16, 9, 0).toISOString() }),
        makeSession({
          session_id: 'yesterday',
          updated_at: new Date(2026, 8, 15, 9, 0).toISOString(),
        }),
        makeSession({ session_id: 'week', updated_at: new Date(2026, 8, 12, 9, 0).toISOString() }),
        makeSession({ session_id: 'older', updated_at: new Date(2026, 7, 1, 9, 0).toISOString() }),
      ],
      NOW,
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today', 'yesterday', 'week', 'older']);
  });

  test('midnight boundary: 23:59 yesterday is yesterday, 00:00 today is today', () => {
    const grouped = groupSessionsByActivity(
      [
        makeSession({
          session_id: 'late-yesterday',
          updated_at: new Date(2026, 8, 15, 23, 59, 59).toISOString(),
        }),
        makeSession({
          session_id: 'midnight-today',
          updated_at: new Date(2026, 8, 16, 0, 0, 0).toISOString(),
        }),
      ],
      NOW,
    );
    const byId = new Map(grouped.sections.map((s) => [s.id, s.sessions.map((x) => x.session_id)]));
    expect(byId.get('yesterday')).toEqual(['late-yesterday']);
    expect(byId.get('today')).toEqual(['midnight-today']);
  });

  test('start-of-yesterday boundary: exactly midnight yesterday is yesterday, one ms earlier is week', () => {
    const startOfYesterday = new Date(2026, 8, 15, 0, 0, 0, 0).getTime();
    const grouped = groupSessionsByActivity(
      [
        makeSession({ session_id: 'at-boundary', updated_at: new Date(startOfYesterday).toISOString() }),
        makeSession({
          session_id: 'before-boundary',
          updated_at: new Date(startOfYesterday - 1).toISOString(),
        }),
      ],
      NOW,
    );
    const byId = new Map(grouped.sections.map((s) => [s.id, s.sessions.map((x) => x.session_id)]));
    expect(byId.get('yesterday')).toEqual(['at-boundary']);
    expect(byId.get('week')).toEqual(['before-boundary']);
  });

  test('7-day edge: exactly 7 local days back is week, one ms earlier is older', () => {
    const todayStart = new Date(2026, 8, 16, 0, 0, 0, 0).getTime();
    const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;
    const grouped = groupSessionsByActivity(
      [
        makeSession({ session_id: 'at-week-edge', updated_at: new Date(weekStart).toISOString() }),
        makeSession({
          session_id: 'past-week-edge',
          updated_at: new Date(weekStart - 1).toISOString(),
        }),
      ],
      NOW,
    );
    const byId = new Map(grouped.sections.map((s) => [s.id, s.sessions.map((x) => x.session_id)]));
    expect(byId.get('week')).toEqual(['at-week-edge']);
    expect(byId.get('older')).toEqual(['past-week-edge']);
  });

  test('a future timestamp still lands in today', () => {
    const grouped = groupSessionsByActivity(
      [makeSession({ session_id: 'a', updated_at: new Date(NOW + 60 * 60_000).toISOString() })],
      NOW,
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today']);
  });

  test('omits empty sections entirely', () => {
    const grouped = groupSessionsByActivity(
      [makeSession({ session_id: 'a', updated_at: new Date(2026, 8, 16, 9, 0).toISOString() })],
      NOW,
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today']);
  });

  test('sessions within a section sort newest-first by last activity', () => {
    const older = makeSession({
      session_id: 'older',
      updated_at: new Date(2026, 8, 16, 1, 0).toISOString(),
    });
    const newer = makeSession({
      session_id: 'newer',
      updated_at: new Date(2026, 8, 16, 9, 0).toISOString(),
    });
    const grouped = groupSessionsByActivity([older, newer], NOW);
    expect(grouped.sections[0].sessions.map((s) => s.session_id)).toEqual(['newer', 'older']);
  });

  test('showHeaders is false with zero populated sections', () => {
    const grouped = groupSessionsByActivity([], NOW);
    expect(grouped.sections).toEqual([]);
    expect(grouped.showHeaders).toBe(false);
  });

  test('showHeaders is false with exactly one populated section', () => {
    const grouped = groupSessionsByActivity(
      [makeSession({ session_id: 'a', updated_at: new Date(2026, 8, 16, 9, 0).toISOString() })],
      NOW,
    );
    expect(grouped.showHeaders).toBe(false);
  });

  test('showHeaders is true with two or more populated sections', () => {
    const grouped = groupSessionsByActivity(
      [
        makeSession({ session_id: 'a', updated_at: new Date(2026, 8, 16, 9, 0).toISOString() }),
        makeSession({ session_id: 'b', updated_at: new Date(2026, 8, 15, 9, 0).toISOString() }),
      ],
      NOW,
    );
    expect(grouped.showHeaders).toBe(true);
  });

  test('section labels match the web copy', () => {
    const grouped = groupSessionsByActivity(
      [
        makeSession({ session_id: 'a', updated_at: new Date(2026, 8, 16, 9, 0).toISOString() }),
        makeSession({ session_id: 'b', updated_at: new Date(2026, 8, 15, 9, 0).toISOString() }),
        makeSession({ session_id: 'c', updated_at: new Date(2026, 8, 12, 9, 0).toISOString() }),
        makeSession({ session_id: 'd', updated_at: new Date(2026, 7, 1, 9, 0).toISOString() }),
      ],
      NOW,
    );
    const labels = new Map(grouped.sections.map((s) => [s.id, s.label]));
    expect(labels.get('today')).toBe('Today');
    expect(labels.get('yesterday')).toBe('Yesterday');
    expect(labels.get('week')).toBe('This week');
    expect(labels.get('older')).toBe('Older');
  });

  test('does not mutate the input array', () => {
    const input = [
      makeSession({ session_id: 'a', updated_at: new Date(2026, 8, 16, 1, 0).toISOString() }),
      makeSession({ session_id: 'b', updated_at: new Date(2026, 8, 16, 9, 0).toISOString() }),
    ];
    const inputCopy = [...input];
    groupSessionsByActivity(input, NOW);
    expect(input).toEqual(inputCopy);
  });
});

describe('filterSessionsByTitle', () => {
  test('an empty query returns the input unchanged', () => {
    const sessions = [makeSession({ session_id: 'a', name: 'Fix login' })];
    expect(filterSessionsByTitle(sessions, '')).toBe(sessions);
  });

  test('a whitespace-only query returns the input unchanged', () => {
    const sessions = [makeSession({ session_id: 'a', name: 'Fix login' })];
    expect(filterSessionsByTitle(sessions, '   ')).toBe(sessions);
  });

  test('matches case-insensitively on a trimmed substring', () => {
    const sessions = [
      makeSession({ session_id: 'a', name: 'Fix login bug' }),
      makeSession({ session_id: 'b', name: 'Add billing page' }),
    ];
    expect(filterSessionsByTitle(sessions, '  LOGIN  ').map((s) => s.session_id)).toEqual(['a']);
  });

  test('matches against the resolved display title, including the untitled fallback', () => {
    const sessions = [
      makeSession({ session_id: 'a' }),
      makeSession({ session_id: 'b', name: 'Named session' }),
    ];
    expect(filterSessionsByTitle(sessions, 'new session').map((s) => s.session_id)).toEqual(['a']);
  });

  test('no match returns an empty array', () => {
    const sessions = [makeSession({ session_id: 'a', name: 'Fix login' })];
    expect(filterSessionsByTitle(sessions, 'nonexistent')).toEqual([]);
  });
});

describe('spokenRelative', () => {
  const NOW = new Date(2026, 8, 16, 10, 0, 0).getTime();

  test('under a minute, or a future timestamp, is "just now"', () => {
    expect(spokenRelative(NOW - 30_000, NOW)).toBe('just now');
    expect(spokenRelative(NOW + 60_000, NOW)).toBe('just now');
  });

  test('uses the same buckets as shortRelative, spelled out', () => {
    expect(spokenRelative(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(spokenRelative(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(spokenRelative(NOW - 60 * 60_000, NOW)).toBe('1 hour ago');
    expect(spokenRelative(NOW - 3 * 60 * 60_000, NOW)).toBe('3 hours ago');
    expect(spokenRelative(NOW - 24 * 60 * 60_000, NOW)).toBe('1 day ago');
    expect(spokenRelative(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2 days ago');
    expect(spokenRelative(NOW - 30 * 24 * 60 * 60_000, NOW)).toBe('1 month ago');
    expect(spokenRelative(NOW - 90 * 24 * 60 * 60_000, NOW)).toBe('3 months ago');
    expect(spokenRelative(NOW - 365 * 24 * 60 * 60_000, NOW)).toBe('1 year ago');
    expect(spokenRelative(NOW - 800 * 24 * 60 * 60_000, NOW)).toBe('2 years ago');
  });
});

describe('sessionStatusLabel', () => {
  test('names every display status in sentence case', () => {
    expect(sessionStatusLabel('starting')).toBe('Starting');
    expect(sessionStatusLabel('running')).toBe('Running');
    expect(sessionStatusLabel('stopped')).toBe('Stopped');
    expect(sessionStatusLabel('failed')).toBe('Failed');
    expect(sessionStatusLabel('needs-you')).toBe('Needs you');
  });
});

describe('recentSessions', () => {
  test('orders by last activity, newest first, without mutating the input', () => {
    const sessions = [
      makeSession({ session_id: 'old', updated_at: '2026-01-01T00:00:00.000Z' }),
      makeSession({ session_id: 'new', updated_at: '2026-03-01T00:00:00.000Z' }),
      makeSession({
        session_id: 'prompted',
        updated_at: '2026-01-02T00:00:00.000Z',
        metadata: { last_activity_at: '2026-04-01T00:00:00.000Z' },
      }),
    ];
    const before = sessions.map((s) => s.session_id);
    expect(recentSessions(sessions, 20).map((s) => s.session_id)).toEqual([
      'prompted',
      'new',
      'old',
    ]);
    expect(sessions.map((s) => s.session_id)).toEqual(before);
  });

  test('keeps only the newest `limit` sessions', () => {
    const sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({
        session_id: `s${i}`,
        updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      }),
    );
    const recent = recentSessions(sessions, 20);
    expect(recent).toHaveLength(20);
    expect(recent[0]?.session_id).toBe('s24');
    expect(recent[19]?.session_id).toBe('s5');
  });

  test('returns every session when there are fewer than `limit`', () => {
    expect(recentSessions([makeSession()], 20)).toHaveLength(1);
    expect(recentSessions([], 20)).toEqual([]);
  });
});
