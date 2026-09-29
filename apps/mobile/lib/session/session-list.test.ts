import { describe, expect, test } from 'bun:test';

import {
  SESSION_STATUS_FILTERS,
  directSubsessions,
  groupSessionsByActivity,
  matchesSessionStatusFilters,
  rootOpenCodeSession,
  sessionDisplayTitle,
  sessionLastActivityAt,
  type SessionStatusFilter,
} from '@kortix/sdk';

import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  sessionStatusFilterSummary,
  sessionStatusLabel,
  spokenRelative,
  SUB_SESSION_FALLBACK_TITLE,
  projectSessionForOpenCodeId,
  subsessionTitle,
  SUBSESSION_COUNT_BADGE_THRESHOLD,
  showSubsessionCountBadge,
} from './session-list';

/**
 * The shared list rules are the SDK's (`@kortix/sdk`, its own tests in
 * packages/sdk/src/core/session/session-list.test.ts). The cases below that
 * the SDK suite does not assert stay here, against the SDK functions this app
 * calls, next to the mobile-only helpers.
 */

/** The Sessions page's status filter, as ProjectSessionsPage applies it. */
function filterSessionsByStatus(
  sessions: ProjectSession[],
  statuses: readonly SessionStatusFilter[],
  needsYou?: ReadonlyMap<string, { count: number }>,
): ProjectSession[] {
  return sessions.filter((session) =>
    matchesSessionStatusFilters(session, statuses, needsYou?.get(session.session_id)?.count ?? 0),
  );
}

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
  // Fix: mobile showed the raw Teams mention tag in a title; the SDK strips it.
  test('a Teams @-mention tag never reaches the row title', () => {
    expect(sessionDisplayTitle(makeSession({ name: '<at>Kortix</at> summarize the thread' }))).toBe(
      'summarize the thread',
    );
    expect(sessionDisplayTitle(makeSession({ custom_name: '<at id="0">Kortix</at>' }))).toBe('New session');
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

describe('filterSessionsByStatus', () => {
  test('an empty set lets every session through', () => {
    const sessions = [makeSession({ session_id: 'a', status: 'running' })];
    expect(filterSessionsByStatus(sessions, [])).toEqual(sessions);
  });

  test('keeps only sessions whose display status is in the set', () => {
    const sessions = [
      makeSession({ session_id: 'a', status: 'running' }),
      makeSession({ session_id: 'b', status: 'failed' }),
      makeSession({ session_id: 'c', status: 'completed' }),
    ];
    expect(
      filterSessionsByStatus(sessions, ['running', 'failed']).map((s) => s.session_id),
    ).toEqual(['a', 'b']);
  });

  // One vocabulary with web: Done and Stopped are two filters, as they are two words.
  test('completed matches Done and stopped matches Stopped', () => {
    const sessions = [
      makeSession({ session_id: 'a', status: 'completed' }),
      makeSession({ session_id: 'b', status: 'stopped' }),
      makeSession({ session_id: 'c', status: 'running' }),
    ];
    expect(
      filterSessionsByStatus(sessions, ['stopped']).map((s) => s.session_id),
    ).toEqual(['b']);
    expect(filterSessionsByStatus(sessions, ['done']).map((s) => s.session_id)).toEqual(['a']);
  });

  test('a set matching nothing returns an empty array', () => {
    const sessions = [makeSession({ session_id: 'a', status: 'running' })];
    expect(filterSessionsByStatus(sessions, ['failed'])).toEqual([]);
  });

  test('running also matches starting sessions (web parity, KRTX-250)', () => {
    const sessions = [
      makeSession({ session_id: 'a', status: 'running' }),
      makeSession({ session_id: 'b', status: 'provisioning' }),
      makeSession({ session_id: 'c', status: 'queued' }),
      makeSession({ session_id: 'd', status: 'branching' }),
      makeSession({ session_id: 'e', status: 'stopped' }),
    ];
    expect(
      filterSessionsByStatus(sessions, ['running']).map((s) => s.session_id),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  test('the filter sheet offers no separate Starting option', () => {
    expect(SESSION_STATUS_FILTERS).toEqual(['needs-you', 'running', 'done', 'stopped', 'failed', 'legacy']);
  });

  test('needs-you matches the sessions with a pending inbox item', () => {
    const sessions = [
      makeSession({ session_id: 'a', status: 'running' }),
      makeSession({ session_id: 'b', status: 'running' }),
      makeSession({ session_id: 'c', status: 'stopped' }),
    ];
    const needsYou = new Map([['b', { count: 1 }], ['c', { count: 2 }]]);
    expect(
      filterSessionsByStatus(sessions, ['needs-you'], needsYou).map((s) => s.session_id),
    ).toEqual(['b', 'c']);
    // A waiting session still matches its lifecycle: someone filtering to
    // Running still wants their review-pending running session (SDK rule;
    // before the SDK, mobile hid it from Running).
    expect(
      filterSessionsByStatus(sessions, ['running'], needsYou).map((s) => s.session_id),
    ).toEqual(['a', 'b']);
  });
});

describe('sessionStatusFilterSummary', () => {
  test('lists the picked statuses in the sheet order, whatever the pick order', () => {
    expect(sessionStatusFilterSummary(new Set(['failed', 'needs-you']))).toBe('Needs you, Failed');
    expect(sessionStatusFilterSummary(new Set(['running']))).toBe('Running');
  });

  test('no pick is an empty string', () => {
    expect(sessionStatusFilterSummary(new Set())).toBe('');
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

// ── OpenCode sub-sessions (web: session-label.ts) ───────────────────────────

function ocNode(
  id: string,
  parentId: string | null,
  overrides: Partial<{ title: string | null; updated_at: number | null; archived_at: number | null }> = {}
) {
  return {
    id,
    title: null,
    parent_id: parentId,
    project_id: null,
    created_at: null,
    updated_at: null,
    archived_at: null,
    ...overrides,
  };
}

describe('rootOpenCodeSession', () => {
  test('no opencode_sessions: null', () => {
    expect(rootOpenCodeSession(makeSession({ opencode_sessions: [] }))).toBeNull();
  });

  test('a missing opencode_sessions array (older payload): null, no throw', () => {
    const session = makeSession({ opencode_sessions: undefined as unknown as ProjectSession['opencode_sessions'] });
    expect(rootOpenCodeSession(session)).toBeNull();
  });

  test('the pinned opencode_session_id wins over a parentless entry', () => {
    const session = makeSession({
      opencode_session_id: 'oc-root',
      opencode_sessions: [ocNode('oc-other', null), ocNode('oc-root', null)],
    } as Partial<ProjectSession>);
    expect(rootOpenCodeSession(session)?.id).toBe('oc-root');
  });

  test('a pin that is not in the snapshot: null (web parity, no guess)', () => {
    const session = makeSession({
      opencode_session_id: 'oc-missing',
      opencode_sessions: [ocNode('oc-root', null)],
    } as Partial<ProjectSession>);
    expect(rootOpenCodeSession(session)).toBeNull();
  });

  test('no pin: the first parentless entry', () => {
    const session = makeSession({
      opencode_session_id: null,
      opencode_sessions: [ocNode('oc-child', 'oc-root'), ocNode('oc-root', null)],
    } as Partial<ProjectSession>);
    expect(rootOpenCodeSession(session)?.id).toBe('oc-root');
  });
});

describe('directSubsessions', () => {
  test('no opencode_sessions: none', () => {
    expect(directSubsessions(makeSession())).toEqual([]);
  });

  test('root only: none', () => {
    const session = makeSession({
      opencode_session_id: 'oc-root',
      opencode_sessions: [ocNode('oc-root', null)],
    } as Partial<ProjectSession>);
    expect(directSubsessions(session)).toEqual([]);
  });

  test('one child of the root', () => {
    const session = makeSession({
      opencode_session_id: 'oc-root',
      opencode_sessions: [ocNode('oc-root', null), ocNode('oc-a', 'oc-root', { title: 'Research' })],
    } as Partial<ProjectSession>);
    expect(directSubsessions(session).map((c) => c.id)).toEqual(['oc-a']);
  });

  test('several children: newest updated_at first, ties and missing times break on id', () => {
    const session = makeSession({
      opencode_session_id: 'oc-root',
      opencode_sessions: [
        ocNode('oc-root', null),
        ocNode('oc-c', 'oc-root', { updated_at: null }),
        ocNode('oc-old', 'oc-root', { updated_at: 1_000 }),
        ocNode('oc-b', 'oc-root', { updated_at: null }),
        ocNode('oc-new', 'oc-root', { updated_at: 5_000 }),
        ocNode('oc-tie-b', 'oc-root', { updated_at: 3_000 }),
        ocNode('oc-tie-a', 'oc-root', { updated_at: 3_000 }),
      ],
    } as Partial<ProjectSession>);
    expect(directSubsessions(session).map((c) => c.id)).toEqual([
      'oc-new',
      'oc-tie-a',
      'oc-tie-b',
      'oc-old',
      'oc-b',
      'oc-c',
    ]);
  });

  test('direct children only: a child of a child is not included', () => {
    const session = makeSession({
      opencode_session_id: 'oc-root',
      opencode_sessions: [
        ocNode('oc-root', null),
        ocNode('oc-a', 'oc-root'),
        ocNode('oc-a-1', 'oc-a'),
      ],
    } as Partial<ProjectSession>);
    expect(directSubsessions(session).map((c) => c.id)).toEqual(['oc-a']);
  });

  test('an archived child is left out', () => {
    const session = makeSession({
      opencode_session_id: 'oc-root',
      opencode_sessions: [
        ocNode('oc-root', null),
        ocNode('oc-a', 'oc-root'),
        ocNode('oc-gone', 'oc-root', { archived_at: 9_000 }),
      ],
    } as Partial<ProjectSession>);
    expect(directSubsessions(session).map((c) => c.id)).toEqual(['oc-a']);
  });

  test('never mutates opencode_sessions', () => {
    const nodes = [ocNode('oc-root', null), ocNode('oc-b', 'oc-root', { updated_at: 1 }), ocNode('oc-a', 'oc-root', { updated_at: 2 })];
    const session = makeSession({ opencode_session_id: 'oc-root', opencode_sessions: nodes } as Partial<ProjectSession>);
    directSubsessions(session);
    expect(nodes.map((n) => n.id)).toEqual(['oc-root', 'oc-b', 'oc-a']);
  });
});

describe('subsessionTitle', () => {
  test('the child title, trimmed', () => {
    expect(subsessionTitle(ocNode('oc-a', 'oc-root', { title: '  Research (@general)  ' }))).toBe(
      'Research (@general)'
    );
  });

  test('a missing or blank title falls back to "Sub-session" (web parity)', () => {
    expect(SUB_SESSION_FALLBACK_TITLE).toBe('Sub-session');
    expect(subsessionTitle(ocNode('oc-a', 'oc-root', { title: null }))).toBe('Sub-session');
    expect(subsessionTitle(ocNode('oc-a', 'oc-root', { title: '   ' }))).toBe('Sub-session');
  });
});

describe('projectSessionForOpenCodeId', () => {
  const parent = makeSession({
    session_id: 'ps-parent',
    opencode_session_id: 'oc-root',
    opencode_sessions: [ocNode('oc-root', null), ocNode('oc-a', 'oc-root'), ocNode('oc-a-1', 'oc-a')],
  } as Partial<ProjectSession>);
  const other = makeSession({
    session_id: 'ps-other',
    opencode_session_id: 'oc-other',
    opencode_sessions: [ocNode('oc-other', null)],
  } as Partial<ProjectSession>);

  test('null id: null', () => {
    expect(projectSessionForOpenCodeId([parent, other], null)).toBeNull();
  });

  test('the root OpenCode id resolves to its project session', () => {
    expect(projectSessionForOpenCodeId([parent, other], 'oc-root')?.session_id).toBe('ps-parent');
    expect(projectSessionForOpenCodeId([parent, other], 'oc-other')?.session_id).toBe('ps-other');
  });

  test('a project session id resolves to itself', () => {
    expect(projectSessionForOpenCodeId([parent, other], 'ps-other')?.session_id).toBe('ps-other');
  });

  test('a direct sub-session id resolves to its parent project session', () => {
    expect(projectSessionForOpenCodeId([other, parent], 'oc-a')?.session_id).toBe('ps-parent');
  });

  test('a deeper descendant (a task opened from a sub-session) resolves to the same project session', () => {
    expect(projectSessionForOpenCodeId([parent, other], 'oc-a-1')?.session_id).toBe('ps-parent');
  });

  test('a pin match wins over a snapshot match in an earlier row', () => {
    const stale = makeSession({
      session_id: 'ps-stale',
      opencode_session_id: 'oc-x',
      opencode_sessions: [ocNode('oc-x', null), ocNode('oc-root', 'oc-x')],
    } as Partial<ProjectSession>);
    expect(projectSessionForOpenCodeId([stale, parent], 'oc-root')?.session_id).toBe('ps-parent');
  });

  test('an unknown id: null', () => {
    expect(projectSessionForOpenCodeId([parent, other], 'oc-nope')).toBeNull();
  });
});

describe('showSubsessionCountBadge', () => {
  test('the threshold is 4: the badge shows only for MORE than 4 sub-sessions', () => {
    expect(SUBSESSION_COUNT_BADGE_THRESHOLD).toBe(4);
  });

  test('0 to 4 sub-sessions: no badge', () => {
    for (const count of [0, 1, 2, 3, 4]) expect(showSubsessionCountBadge(count)).toBe(false);
  });

  test('5 or more sub-sessions: badge', () => {
    for (const count of [5, 6, 12, 99]) expect(showSubsessionCountBadge(count)).toBe(true);
  });

  test('a negative or non-finite count never shows a badge', () => {
    expect(showSubsessionCountBadge(-1)).toBe(false);
    expect(showSubsessionCountBadge(Number.NaN)).toBe(false);
  });
});

