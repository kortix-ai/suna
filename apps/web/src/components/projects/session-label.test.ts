import { describe, expect, test } from 'bun:test';

import type { ProjectSession, ProjectSessionStatus } from '@kortix/sdk';
import {
  availableSessionFilterOptions,
  availableSessionStatusFilterOptions,
  matchesSessionStatusFilter,
  SESSION_DISPLAY_STATUS_LABELS,
  sessionDisplayStatus,
  type SessionDisplayStatus,
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

  test('a pending review does not change status matching', () => {
    // The filter reads the lifecycle, not the review overlay.
    expect(matchesSessionStatusFilter(makeSession({ status: 'running' }), 'running')).toBe(true);
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
