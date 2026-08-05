import { describe, expect, test } from 'bun:test';

import type { ProjectSession, ProjectSessionStatus } from '@kortix/sdk';
import {
  availableSessionFilterOptions,
  availableSessionStatusFilterOptions,
  matchesSessionStatusFilter,
  resolveSessionFilterMenu,
  SESSION_DISPLAY_STATUS_LABELS,
  sessionDisplayStatus,
  type SessionDisplayStatus,
  type SessionFilterValue,
  type SessionStatusFilterValue,
} from './session-label';

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

const myChat = () => makeSession({ is_owner: true });
const sharedChat = () => makeSession({ is_owner: false });
const slack = () => makeSession({ metadata: { source: 'slack' } });
const email = () => makeSession({ metadata: { source: 'email' } });
const scheduled = () =>
  makeSession({ metadata: { trigger_source: 'cron', trigger_type: 'cron', trigger_slug: 'daily' } });
const telegram = () => makeSession({ metadata: { source: 'telegram' } });

describe('availableSessionFilterOptions', () => {
  test('one source only: no options, because every filter equals "All"', () => {
    expect(availableSessionFilterOptions([myChat(), myChat()])).toEqual([]);
    expect(availableSessionFilterOptions([sharedChat()])).toEqual([]);
    expect(availableSessionFilterOptions([slack(), slack()])).toEqual([]);
    expect(availableSessionFilterOptions([email()])).toEqual([]);
    expect(availableSessionFilterOptions([scheduled()])).toEqual([]);
  });

  test('no sessions: no options', () => {
    expect(availableSessionFilterOptions([])).toEqual([]);
  });

  test('two sources: "All" plus exactly the present ones, in canonical order', () => {
    const options = availableSessionFilterOptions([slack(), myChat(), email()]);

    expect(options.map((option) => option.value)).toEqual(['all', 'mine', 'slack', 'email']);
  });

  test('a source with zero sessions never gets a row', () => {
    const options = availableSessionFilterOptions([myChat(), sharedChat()]);

    expect(options.map((option) => option.value)).toEqual(['all', 'mine', 'shared']);
    expect(options.every((option) => option.count > 0)).toBe(true);
  });

  test('counts match the sessions each filter selects', () => {
    const sessions = [myChat(), myChat(), sharedChat(), slack(), scheduled(), scheduled()];

    const counts = Object.fromEntries(
      availableSessionFilterOptions(sessions).map((option) => [option.value, option.count]),
    );

    expect(counts).toEqual({ all: 6, mine: 2, shared: 1, slack: 1, schedule: 2 });
  });

  test('"All" counts kinds no filter covers, so the total never lies', () => {
    const options = availableSessionFilterOptions([myChat(), slack(), telegram()]);

    expect(options[0]).toEqual({ value: 'all', label: 'All', count: 3 });
    expect(options.map((option) => option.value)).not.toContain('telegram');
  });

  test('telegram-only projects get no menu: it is one source with no filter', () => {
    expect(availableSessionFilterOptions([telegram(), telegram()])).toEqual([]);
  });
});

describe('sessionDisplayStatus', () => {
  const cases: Array<[ProjectSessionStatus, SessionDisplayStatus]> = [
    ['queued', 'starting'],
    ['branching', 'starting'],
    ['provisioning', 'starting'],
    ['running', 'running'],
    ['completed', 'done'],
    ['stopped', 'stopped'],
    ['failed', 'failed'],
  ];

  for (const [status, expected] of cases) {
    test(`maps ${status} to ${expected}`, () => {
      expect(sessionDisplayStatus(makeSession({ status }))).toBe(expected);
    });
  }

  test('defaults reviewCount to 0 so a running session stays running', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'running' }))).toBe('running');
  });

  test('a pending review overrides every lifecycle status', () => {
    for (const [status] of cases) {
      expect(sessionDisplayStatus(makeSession({ status }), 1)).toBe('needs-you');
    }
  });

  test('a zero review count does not override', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'completed' }), 0)).toBe('done');
  });

  test('every display status has a label', () => {
    const all: SessionDisplayStatus[] = [
      'needs-you', 'starting', 'running', 'done', 'stopped', 'failed',
    ];
    for (const value of all) {
      expect(SESSION_DISPLAY_STATUS_LABELS[value]).toBeTruthy();
    }
  });

  test('an unknown lifecycle value degrades instead of throwing', () => {
    // ProjectSessionStatus is a published SDK union: an API that grows an
    // eighth member ships a value this build has never seen. Returning
    // undefined here used to take the whole sidebar down at
    // STATUS_DOT_STYLE[undefined].color.
    const session = makeSession({ status: 'hibernating' as ProjectSessionStatus });
    expect(() => sessionDisplayStatus(session)).not.toThrow();
    const display = sessionDisplayStatus(session);
    expect(SESSION_DISPLAY_STATUS_LABELS[display]).toBeTruthy();
    // Never green: green means live or actionable.
    expect(display).not.toBe('running');
    expect(display).not.toBe('needs-you');
  });

  test('labels never say "Active" — the data cannot support it', () => {
    expect(Object.values(SESSION_DISPLAY_STATUS_LABELS)).not.toContain('Active');
  });
});

describe('matchesSessionStatusFilter', () => {
  test('all matches every lifecycle status', () => {
    const statuses: ProjectSessionStatus[] = [
      'queued', 'branching', 'provisioning', 'running', 'completed', 'stopped', 'failed',
    ];
    for (const status of statuses) {
      expect(matchesSessionStatusFilter(makeSession({ status }), 'all')).toBe(true);
    }
  });

  test('running covers the whole starting family plus running', () => {
    for (const status of ['queued', 'branching', 'provisioning', 'running'] as const) {
      expect(matchesSessionStatusFilter(makeSession({ status }), 'running')).toBe(true);
    }
    expect(matchesSessionStatusFilter(makeSession({ status: 'completed' }), 'running')).toBe(false);
  });

  test('done matches only completed', () => {
    expect(matchesSessionStatusFilter(makeSession({ status: 'completed' }), 'done')).toBe(true);
    expect(matchesSessionStatusFilter(makeSession({ status: 'stopped' }), 'done')).toBe(false);
  });

  test('stopped and failed match only themselves', () => {
    expect(matchesSessionStatusFilter(makeSession({ status: 'stopped' }), 'stopped')).toBe(true);
    expect(matchesSessionStatusFilter(makeSession({ status: 'failed' }), 'failed')).toBe(true);
    expect(matchesSessionStatusFilter(makeSession({ status: 'failed' }), 'stopped')).toBe(false);
  });
});

describe('availableSessionStatusFilterOptions', () => {
  test('returns [] for a single represented status — every option would equal All', () => {
    const sessions = [makeSession({ status: 'running' }), makeSession({ status: 'queued' })];
    expect(availableSessionStatusFilterOptions(sessions)).toEqual([]);
  });

  test('prepends All with the total, and omits zero-count options', () => {
    const sessions = [
      makeSession({ session_id: 'a', status: 'running' }),
      makeSession({ session_id: 'b', status: 'completed' }),
      makeSession({ session_id: 'c', status: 'completed' }),
    ];
    const options = availableSessionStatusFilterOptions(sessions);
    expect(options.map((option) => option.value)).toEqual(['all', 'running', 'done']);
    expect(options[0].count).toBe(3);
    expect(options[1].count).toBe(1);
    expect(options[2].count).toBe(2);
    expect(options.some((option) => option.value === 'failed')).toBe(false);
  });

  test('returns [] for an empty session list', () => {
    expect(availableSessionStatusFilterOptions([])).toEqual([]);
  });

  test('options keep the declared order, not discovery order', () => {
    const sessions = [
      makeSession({ session_id: 'a', status: 'failed' }),
      makeSession({ session_id: 'b', status: 'running' }),
    ];
    expect(availableSessionStatusFilterOptions(sessions).map((o) => o.value)).toEqual([
      'all', 'running', 'failed',
    ]);
  });
});

describe('resolveSessionFilterMenu', () => {
  // 3 Slack sessions, all completed; 1 chat session, running. Two sources and
  // two statuses, so both dimensions are offered when neither is filtered.
  const mixed = () => [
    makeSession({ session_id: 'k1', metadata: { source: 'slack' }, status: 'completed' }),
    makeSession({ session_id: 'k2', metadata: { source: 'slack' }, status: 'completed' }),
    makeSession({ session_id: 'k3', metadata: { source: 'slack' }, status: 'completed' }),
    makeSession({ session_id: 'c1', status: 'running' }),
  ];

  test('unfiltered, both dimensions count the whole set', () => {
    const menu = resolveSessionFilterMenu(mixed(), 'all', 'all');
    expect(menu.statusOptions.map((o) => [o.value, o.count])).toEqual([
      ['all', 4], ['running', 1], ['done', 3],
    ]);
    expect(menu.filterOptions.map((o) => [o.value, o.count])).toEqual([
      ['all', 4], ['mine', 1], ['slack', 3],
    ]);
  });

  test('the status menu never offers a count the source filter would drop', () => {
    // The reported defect: Source=Slack, every Slack session completed, and the
    // status menu still offered "Running 1" — which rendered zero rows.
    const menu = resolveSessionFilterMenu(mixed(), 'slack', 'all');
    expect(menu.statusOptions.some((o) => o.value === 'running')).toBe(false);
    // Only "Done" survives the facet, so the whole status group is dropped:
    // one option renders the same list as All.
    expect(menu.statusOptions).toEqual([]);
  });

  test('the source menu never offers a count the status filter would drop', () => {
    const menu = resolveSessionFilterMenu(mixed(), 'all', 'running');
    expect(menu.filterOptions.some((o) => o.value === 'slack')).toBe(false);
    expect(menu.filterOptions).toEqual([]);
  });

  test('an active status stays listed, at its true count of 0, when the source empties it', () => {
    const menu = resolveSessionFilterMenu(mixed(), 'slack', 'running');
    expect(menu.activeStatus).toBe('running');
    expect(menu.statusOptions.map((o) => [o.value, o.count])).toEqual([
      ['all', 3], ['running', 0], ['done', 3],
    ]);
  });

  test('an active source stays listed, at its true count of 0, when the status empties it', () => {
    const menu = resolveSessionFilterMenu(mixed(), 'slack', 'running');
    expect(menu.activeFilter).toBe('slack');
    expect(menu.filterOptions.map((o) => [o.value, o.count])).toEqual([
      ['all', 1], ['mine', 1], ['slack', 0],
    ]);
  });

  test('a filter whose sessions are all gone falls back to all', () => {
    const menu = resolveSessionFilterMenu(mixed(), 'email', 'failed');
    expect(menu.activeFilter).toBe('all');
    expect(menu.activeStatus).toBe('all');
  });

  test('an empty session set offers nothing and filters by nothing', () => {
    expect(resolveSessionFilterMenu([], 'slack', 'failed')).toEqual({
      filterOptions: [],
      statusOptions: [],
      activeFilter: 'all',
      activeStatus: 'all',
    });
  });

  // Termination: recovery reads the UNFACETED set, so one dimension resetting
  // can never move the other. Feeding the resolved values back in must be a
  // no-op — if it were not, the two dimensions could push each other forever.
  test('resolving is idempotent for every filter pair', () => {
    const sources: SessionFilterValue[] = ['all', 'mine', 'shared', 'slack', 'email'];
    const statuses: SessionStatusFilterValue[] = ['all', 'running', 'done', 'stopped', 'failed'];
    for (const source of sources) {
      for (const status of statuses) {
        const once = resolveSessionFilterMenu(mixed(), source, status);
        const twice = resolveSessionFilterMenu(mixed(), once.activeFilter, once.activeStatus);
        expect(twice).toEqual(once);
      }
    }
  });

  test('the active option is always reachable in its own menu', () => {
    const sources: SessionFilterValue[] = ['all', 'mine', 'shared', 'slack', 'email'];
    const statuses: SessionStatusFilterValue[] = ['all', 'running', 'done', 'stopped', 'failed'];
    for (const source of sources) {
      for (const status of statuses) {
        const menu = resolveSessionFilterMenu(mixed(), source, status);
        // Either the group is dropped entirely (nothing to be stranded in), or
        // the active value is one of its rows.
        if (menu.filterOptions.length > 0) {
          expect(menu.filterOptions.some((o) => o.value === menu.activeFilter)).toBe(true);
        }
        if (menu.statusOptions.length > 0) {
          expect(menu.statusOptions.some((o) => o.value === menu.activeStatus)).toBe(true);
        }
        // A dropped group only ever happens while that dimension is unfiltered.
        if (menu.filterOptions.length === 0) expect(menu.activeFilter).toBe('all');
        if (menu.statusOptions.length === 0) expect(menu.activeStatus).toBe('all');
      }
    }
  });
});
