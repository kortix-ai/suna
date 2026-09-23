import { describe, expect, test } from 'bun:test';

import {
  type SessionLike,
  UNTITLED_SESSION,
  dayLabel,
  filterSessionsByTitle,
  groupSessionsByDay,
  parentSessionId,
  sessionActivityMs,
  sessionTitle,
} from './session-groups.ts';

/** 2026-09-17 is a Thursday. Every case below is pinned to local noon so a
 *  calendar-day boundary is never a timezone artifact. */
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const DAY_MS = 86_400_000;

function session(
  id: string,
  activityMsBack: number,
  extra: Partial<SessionLike> = {},
): SessionLike {
  return {
    session_id: id,
    name: id,
    metadata: { last_activity_at: new Date(NOW - activityMsBack).toISOString() },
    ...extra,
  };
}

describe('sessionActivityMs', () => {
  test('prefers the API prompt stamp', () => {
    const row: SessionLike = {
      session_id: 's',
      metadata: { last_activity_at: '2026-09-17T10:00:00.000Z' },
      updated_at: '2026-09-01T00:00:00.000Z',
    };
    expect(sessionActivityMs(row)).toBe(Date.parse('2026-09-17T10:00:00.000Z'));
  });

  test('takes the newer of the prompt stamp and the conversation snapshot', () => {
    const snapshot = Date.parse('2026-09-17T11:30:00.000Z');
    const row: SessionLike = {
      session_id: 's',
      metadata: { last_activity_at: '2026-09-17T10:00:00.000Z' },
      opencode_sessions: [{ updated_at: snapshot }, { updated_at: null }],
    };
    expect(sessionActivityMs(row)).toBe(snapshot);
  });

  test('falls back to updated_at, then created_at, then 0', () => {
    expect(sessionActivityMs({ session_id: 's', updated_at: '2026-09-02T00:00:00.000Z' })).toBe(
      Date.parse('2026-09-02T00:00:00.000Z'),
    );
    expect(sessionActivityMs({ session_id: 's', created_at: '2026-09-03T00:00:00.000Z' })).toBe(
      Date.parse('2026-09-03T00:00:00.000Z'),
    );
    expect(sessionActivityMs({ session_id: 's' })).toBe(0);
  });

  test('ignores a metadata stamp that is not a timestamp', () => {
    expect(sessionActivityMs({ session_id: 's', metadata: { last_activity_at: {} } })).toBe(0);
  });
});

describe('sessionTitle', () => {
  test('the user override wins over the server name', () => {
    expect(sessionTitle({ session_id: 's', name: 'Auto', custom_name: 'Mine' })).toBe('Mine');
  });
  test('the server name is used when there is no override', () => {
    expect(sessionTitle({ session_id: 's', name: 'Auto', custom_name: null })).toBe('Auto');
  });
  test('a nameless session reads Untitled', () => {
    expect(sessionTitle({ session_id: 's', name: '   ' })).toBe(UNTITLED_SESSION);
  });
});

describe('dayLabel', () => {
  test('today, yesterday, weekday, then the ISO date', () => {
    expect(dayLabel(NOW, NOW)).toBe('Today');
    expect(dayLabel(NOW - DAY_MS, NOW)).toBe('Yesterday');
    expect(dayLabel(NOW - 2 * DAY_MS, NOW)).toBe('Tuesday');
    expect(dayLabel(NOW - 6 * DAY_MS, NOW)).toBe('Friday');
    expect(dayLabel(NOW - 7 * DAY_MS, NOW)).toBe('2026-09-10');
  });

  test('buckets on calendar days, not a rolling 24h window', () => {
    const lastNight = new Date(2026, 8, 16, 23, 50).getTime();
    const justAfterMidnight = new Date(2026, 8, 17, 0, 10).getTime();
    expect(dayLabel(lastNight, justAfterMidnight)).toBe('Yesterday');
  });

  test('a future timestamp reads Today', () => {
    expect(dayLabel(NOW + 3 * DAY_MS, NOW)).toBe('Today');
  });
});

describe('parentSessionId', () => {
  const present = new Set(['parent', 'child']);
  test('reads metadata.spawned_by_session', () => {
    expect(
      parentSessionId({ session_id: 'child', metadata: { spawned_by_session: 'parent' } }, present),
    ).toBe('parent');
  });
  test('an absent parent leaves the row a root', () => {
    expect(
      parentSessionId({ session_id: 'child', metadata: { spawned_by_session: 'gone' } }, present),
    ).toBeNull();
  });
  test('a self-reference is not a parent', () => {
    expect(
      parentSessionId({ session_id: 'child', metadata: { spawned_by_session: 'child' } }, present),
    ).toBeNull();
  });
});

describe('groupSessionsByDay', () => {
  test('sections are ordered by activity and labelled by day', () => {
    const groups = groupSessionsByDay(
      [session('older', 3 * DAY_MS), session('newest', 60_000), session('yesterday', DAY_MS)],
      { now: NOW },
    );
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', 'Monday']);
    expect(groups[0]?.rows.map((row) => row.session.session_id)).toEqual(['newest']);
    expect(groups[2]?.rows.map((row) => row.session.session_id)).toEqual(['older']);
  });

  test('a spawned session renders at depth 1 under its parent', () => {
    const parent = session('parent', 60_000);
    const child = session('child', 120_000, {
      metadata: {
        last_activity_at: new Date(NOW - 120_000).toISOString(),
        spawned_by_session: 'parent',
      },
    });
    const groups = groupSessionsByDay([child, parent], { now: NOW });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows).toEqual([
      { session: parent, depth: 0 },
      { session: child, depth: 1 },
    ]);
  });

  test('a child stays with its parent even when its activity is on another day', () => {
    const parent = session('parent', 60_000);
    const child = session('child', 3 * DAY_MS, {
      metadata: {
        last_activity_at: new Date(NOW - 3 * DAY_MS).toISOString(),
        spawned_by_session: 'parent',
      },
    });
    const groups = groupSessionsByDay([parent, child], { now: NOW });
    expect(groups.map((group) => group.label)).toEqual(['Today']);
    expect(groups[0]?.rows.map((row) => [row.session.session_id, row.depth])).toEqual([
      ['parent', 0],
      ['child', 1],
    ]);
  });

  test('a grandchild attaches to its root ancestor instead of disappearing', () => {
    const root = session('root', 60_000);
    const child = session('child', 120_000, {
      metadata: {
        last_activity_at: new Date(NOW - 120_000).toISOString(),
        spawned_by_session: 'root',
      },
    });
    const grandchild = session('grandchild', 180_000, {
      metadata: {
        last_activity_at: new Date(NOW - 180_000).toISOString(),
        spawned_by_session: 'child',
      },
    });
    const rows = groupSessionsByDay([root, child, grandchild], { now: NOW })[0]?.rows ?? [];
    expect(rows.map((row) => [row.session.session_id, row.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['grandchild', 1],
    ]);
  });

  test('a child whose parent is not loaded renders as a root', () => {
    const child = session('child', 60_000, {
      metadata: {
        last_activity_at: new Date(NOW - 60_000).toISOString(),
        spawned_by_session: 'not-loaded',
      },
    });
    const rows = groupSessionsByDay([child], { now: NOW })[0]?.rows ?? [];
    expect(rows).toEqual([{ session: child, depth: 0 }]);
  });

  test('a metadata cycle still renders every row exactly once', () => {
    const a = session('a', 60_000, {
      metadata: { last_activity_at: new Date(NOW - 60_000).toISOString(), spawned_by_session: 'b' },
    });
    const b = session('b', 120_000, {
      metadata: {
        last_activity_at: new Date(NOW - 120_000).toISOString(),
        spawned_by_session: 'a',
      },
    });
    const rows = groupSessionsByDay([a, b], { now: NOW }).flatMap((group) => group.rows);
    expect(rows.map((row) => row.session.session_id).sort()).toEqual(['a', 'b']);
  });

  test('an empty list makes no sections', () => {
    expect(groupSessionsByDay([], { now: NOW })).toEqual([]);
  });

  test('never mutates the input array', () => {
    const input = [session('a', 60_000), session('b', 120_000)];
    const copy = input.slice();
    groupSessionsByDay(input, { now: NOW });
    expect(input).toEqual(copy);
  });
});

describe('filterSessionsByTitle', () => {
  const rows = [
    { session_id: '1', name: 'Digest the day' },
    { session_id: '2', name: 'CRM pipeline deck' },
    { session_id: '3', name: null, custom_name: 'Ping test' },
  ];
  test('matches the displayed title, case-insensitively', () => {
    expect(filterSessionsByTitle(rows, 'crm').map((row) => row.session_id)).toEqual(['2']);
    expect(filterSessionsByTitle(rows, 'PING').map((row) => row.session_id)).toEqual(['3']);
  });
  test('an empty query returns everything', () => {
    expect(filterSessionsByTitle(rows, '  ')).toHaveLength(3);
  });
  test('no match returns nothing', () => {
    expect(filterSessionsByTitle(rows, 'zzz')).toEqual([]);
  });
});
