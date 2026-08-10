import type { ProjectSession } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
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
      mode: 'status',
      order: 'activity',
      reviewCountBySession: { run: 2 },
      now: NOW,
    });
    expect(grouped.sections.flatMap((s) => s.sessions.map((x) => x.session_id))).toEqual(['run']);
  });

  test('a zero review count does not move a session into needs-you', () => {
    const grouped = groupSessions([makeSession({ session_id: 'run', status: 'running' })], {
      mode: 'status',
      order: 'activity',
      reviewCountBySession: { run: 0 },
      now: NOW,
    });
    expect(grouped.sections.map((s) => s.id)).toEqual(['running']);
  });

  test('starting (provisioning) sits in the running section', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'start', status: 'provisioning' }),
        makeSession({ session_id: 'done', status: 'completed' }),
      ],
      { mode: 'status', order: 'activity', reviewCountBySession: {}, now: NOW },
    );
    const runningSection = grouped.sections.find((s) => s.id === 'running');
    expect(runningSection?.sessions.map((s) => s.session_id)).toEqual(['start']);
  });

  test('recent holds completed, stopped and failed', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'done', status: 'completed' }),
        makeSession({ session_id: 'stop', status: 'stopped' }),
        makeSession({ session_id: 'fail', status: 'failed' }),
        makeSession({ session_id: 'run', status: 'running' }),
      ],
      { mode: 'status', order: 'activity', reviewCountBySession: {}, now: NOW },
    );
    const recent = grouped.sections.find((s) => s.id === 'recent');
    expect(recent?.sessions.map((s) => s.session_id).sort()).toEqual(['done', 'fail', 'stop']);
  });

  test('omits an empty section entirely (not just a hidden one)', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'done', status: 'completed' }),
        makeSession({ session_id: 'stop', status: 'stopped' }),
      ],
      { mode: 'status', order: 'activity', reviewCountBySession: {}, now: NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['recent']);
  });

  test('showHeaders is true at two or more populated sections', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'run', status: 'running' }),
        makeSession({ session_id: 'done', status: 'completed' }),
      ],
      { mode: 'status', order: 'activity', reviewCountBySession: {}, now: NOW },
    );
    expect(grouped.showHeaders).toBe(true);
  });

  test('sorts newest-first within each section under the default activity order', () => {
    const older = makeSession({
      session_id: 'older',
      status: 'completed',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeSession({
      session_id: 'newer',
      status: 'completed',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    const grouped = groupSessions([older, newer], {
      mode: 'status',
      order: 'activity',
      reviewCountBySession: {},
      now: NOW,
    });
    expect(grouped.sections[0].sessions.map((s) => s.session_id)).toEqual(['newer', 'older']);
  });
});

describe('groupSessions — activity mode', () => {
  // Bucketing reads LOCAL calendar components (see session-grouping.ts), so
  // both `now` and every fixture below must be built with local-constructed
  // `new Date(y, m, d, ...)` rather than a fixed-UTC ISO literal. Mixing a
  // UTC instant for `now` with UTC ISO fixtures drifts at the timezone
  // boundary: at UTC+12 and above, a UTC-noon `now` has already rolled to
  // the next local calendar day, so a "same UTC day" fixture reads as
  // yesterday locally. Local-constructing both sides keeps the test
  // self-consistent in any timezone.
  const ACTIVITY_NOW = new Date(2026, 7, 6, 12, 0, 0).getTime();

  test('buckets by age against the injected now', () => {
    const grouped = groupSessions(
      [
        makeSession({
          session_id: 'a',
          created_at: new Date(2026, 7, 6, 9, 0, 0).toISOString(),
        }),
        makeSession({
          session_id: 'b',
          created_at: new Date(2026, 7, 5, 9, 0, 0).toISOString(),
        }),
        makeSession({
          session_id: 'c',
          created_at: new Date(2026, 7, 2, 9, 0, 0).toISOString(),
        }),
        makeSession({
          session_id: 'd',
          created_at: new Date(2026, 5, 1, 9, 0, 0).toISOString(),
        }),
      ],
      { mode: 'activity', order: 'activity', reviewCountBySession: {}, now: ACTIVITY_NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today', 'yesterday', 'week', 'older']);
  });

  // The reported regression: an 8-day-old session that is still used every day
  // sat in "Older", because with no conversation snapshot the sidebar dated it
  // by CREATION. Buckets follow use, not birth.
  test('an old session used today groups under Today', () => {
    const grouped = groupSessions(
      [
        makeSession({
          session_id: 'old-but-active',
          created_at: new Date(2026, 6, 29, 9, 0, 0).toISOString(),
          metadata: { last_activity_at: new Date(2026, 7, 6, 11, 0, 0).toISOString() },
        }),
      ],
      { mode: 'activity', order: 'activity', reviewCountBySession: {}, now: ACTIVITY_NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today']);
  });

  test('a session created today but never used since stays in Today', () => {
    const grouped = groupSessions(
      [
        makeSession({
          session_id: 'fresh',
          created_at: new Date(2026, 7, 6, 9, 0, 0).toISOString(),
        }),
      ],
      { mode: 'activity', order: 'activity', reviewCountBySession: {}, now: ACTIVITY_NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today']);
  });

  test('review state does not move a session out of its date bucket', () => {
    const grouped = groupSessions(
      [
        makeSession({
          session_id: 'a',
          created_at: new Date(2026, 7, 6, 9, 0, 0).toISOString(),
        }),
      ],
      { mode: 'activity', order: 'activity', reviewCountBySession: { a: 3 }, now: ACTIVITY_NOW },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['today']);
  });

  describe('calendar-day boundaries, not rolling 24h', () => {
    // now = local Aug 6, 22:00 — chosen so a rolling-24h window and a
    // calendar-day boundary disagree on where "yesterday, 23:00" lands.
    const LOCAL_NOW = new Date(2026, 7, 6, 22, 0, 0).getTime();

    test('23:00 the local calendar day before now is yesterday, not today', () => {
      // Rolling-24h would put this ~23h before `now` — inside the 24h
      // window, so "today". It is the previous calendar date, so it must
      // bucket as yesterday.
      const activityMs = new Date(2026, 7, 5, 23, 0, 0).getTime();
      const grouped = groupSessions(
        [makeSession({ session_id: 'a', created_at: new Date(activityMs).toISOString() })],
        { mode: 'activity', order: 'activity', reviewCountBySession: {}, now: LOCAL_NOW },
      );
      expect(grouped.sections.map((s) => s.id)).toEqual(['yesterday']);
    });

    test('00:30 the same local calendar day as now is today', () => {
      const activityMs = new Date(2026, 7, 6, 0, 30, 0).getTime();
      const grouped = groupSessions(
        [makeSession({ session_id: 'a', created_at: new Date(activityMs).toISOString() })],
        { mode: 'activity', order: 'activity', reviewCountBySession: {}, now: LOCAL_NOW },
      );
      expect(grouped.sections.map((s) => s.id)).toEqual(['today']);
    });

    test('a timestamp ~1 hour in the future still lands in today', () => {
      const activityMs = LOCAL_NOW + 60 * 60 * 1000;
      const grouped = groupSessions(
        [makeSession({ session_id: 'a', created_at: new Date(activityMs).toISOString() })],
        { mode: 'activity', order: 'activity', reviewCountBySession: {}, now: LOCAL_NOW },
      );
      expect(grouped.sections.map((s) => s.id)).toEqual(['today']);
    });
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
      mode: 'none',
      order: 'activity',
      reviewCountBySession: {},
      now: NOW,
    });
    expect(grouped.sections.map((s) => s.id)).toEqual(['all']);
    expect(grouped.showHeaders).toBe(false);
  });
});

describe('groupSessions — ordering', () => {
  const older = makeSession({
    session_id: 'older',
    name: 'Zebra',
    created_at: '2026-08-01T00:00:00.000Z',
  });
  const newer = makeSession({
    session_id: 'newer',
    name: 'Alpha',
    created_at: '2026-08-05T00:00:00.000Z',
  });

  test('created sorts newest first', () => {
    const grouped = groupSessions([older, newer], {
      mode: 'none',
      order: 'created',
      reviewCountBySession: {},
      now: NOW,
    });
    expect(grouped.sections[0].sessions.map((s) => s.session_id)).toEqual(['newer', 'older']);
  });

  test('name sorts A to Z, case-insensitively', () => {
    // 'Banana' < 'apple' under a plain case-sensitive localeCompare (capitals
    // sort first), so this fixture only passes when { sensitivity: 'base' }
    // is actually applied — unlike 'Alpha'/'Zebra', which sort the same
    // either way and would pass even with case-sensitivity silently dropped.
    const lower = makeSession({
      session_id: 'lower',
      name: 'apple',
      created_at: '2026-08-01T00:00:00.000Z',
    });
    const upper = makeSession({
      session_id: 'upper',
      name: 'Banana',
      created_at: '2026-08-05T00:00:00.000Z',
    });
    const grouped = groupSessions([upper, lower], {
      mode: 'none',
      order: 'name',
      reviewCountBySession: {},
      now: NOW,
    });
    expect(grouped.sections[0].sessions.map((s) => s.session_id)).toEqual(['lower', 'upper']);
  });
});

describe('groupSessions — hidden sections and invariants', () => {
  test('a hidden section is dropped entirely', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'run', status: 'running' }),
        makeSession({ session_id: 'done', status: 'completed' }),
      ],
      {
        mode: 'status',
        order: 'activity',
        reviewCountBySession: {},
        hiddenSections: ['running'],
        now: NOW,
      },
    );
    expect(grouped.sections.map((s) => s.id)).toEqual(['recent']);
  });

  test('showHeaders is false at one or zero populated sections', () => {
    const one = groupSessions([makeSession({ status: 'completed' })], {
      mode: 'status',
      order: 'activity',
      reviewCountBySession: {},
      now: NOW,
    });
    expect(one.showHeaders).toBe(false);
    const none = groupSessions([], {
      mode: 'status',
      order: 'activity',
      reviewCountBySession: {},
      now: NOW,
    });
    expect(none.sections).toEqual([]);
    expect(none.showHeaders).toBe(false);
  });

  test('a section carries its id, label and sessions — and nothing else', () => {
    const grouped = groupSessions(
      [
        makeSession({ session_id: 'run', status: 'running' }),
        makeSession({ session_id: 'd', status: 'completed' }),
      ],
      { mode: 'status', order: 'activity', reviewCountBySession: {}, now: NOW },
    );
    // Headers render the label alone; counts were removed from the UI, so a
    // section exposing a count field again would be dead surface.
    for (const section of grouped.sections) {
      expect(Object.keys(section).sort()).toEqual(['id', 'label', 'sessions']);
    }
  });

  test('does not mutate the input array', () => {
    const input = [makeSession({ session_id: 'a' }), makeSession({ session_id: 'b' })];
    groupSessions(input, { mode: 'status', order: 'name', reviewCountBySession: {}, now: NOW });
    expect(input.map((s) => s.session_id)).toEqual(['a', 'b']);
  });
});
