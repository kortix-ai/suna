import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';
import type { ProjectSession, ProjectSessionStatus } from '@kortix/sdk';
import {
  directSubsessions,
  isLegacyMigratedSession,
  matchesSourceFilters,
  matchesStatusFilters,
  SESSION_DISPLAY_STATUS_LABELS,
  sessionDisplayStatus,
  sessionIsShared,
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
      'needs-you',
      'starting',
      'running',
      'done',
      'stopped',
      'failed',
      'legacy',
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

describe('legacy migrated sessions', () => {
  const legacyMeta = {
    legacy_migration: { run_id: 'suna-a1', source_sandbox_id: 'proj-1' },
  };

  test('detected by legacy_migration metadata', () => {
    expect(isLegacyMigratedSession(makeSession({ metadata: legacyMeta }))).toBe(true);
    expect(isLegacyMigratedSession(makeSession({ metadata: {} }))).toBe(false);
    expect(isLegacyMigratedSession(makeSession())).toBe(false);
  });

  test("dormant migrated sessions display as 'legacy', never 'done' or 'stopped'", () => {
    expect(sessionDisplayStatus(makeSession({ status: 'completed', metadata: legacyMeta }))).toBe(
      'legacy',
    );
    expect(sessionDisplayStatus(makeSession({ status: 'stopped', metadata: legacyMeta }))).toBe(
      'legacy',
    );
  });

  test('a restored (live) migrated session keeps its live paint', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'running', metadata: legacyMeta }))).toBe(
      'running',
    );
    expect(
      sessionDisplayStatus(makeSession({ status: 'provisioning', metadata: legacyMeta })),
    ).toBe('starting');
  });

  test('a pending review still outranks the legacy state', () => {
    expect(
      sessionDisplayStatus(makeSession({ status: 'completed', metadata: legacyMeta }), 1),
    ).toBe('needs-you');
  });

  test("the 'legacy' filter matches migrated sessions; 'done' does not", () => {
    const dormant = makeSession({ status: 'completed', metadata: legacyMeta });
    expect(matchesStatusFilters(dormant, ['legacy'])).toBe(true);
    expect(matchesStatusFilters(dormant, ['done'])).toBe(false);
    expect(matchesStatusFilters(makeSession({ status: 'completed' }), ['legacy'])).toBe(false);
  });
});

describe('matchesStatusFilters', () => {
  test('an empty array matches everything', () => {
    for (const status of ['queued', 'running', 'completed', 'stopped', 'failed'] as const) {
      expect(matchesStatusFilters(makeSession({ status }), [])).toBe(true);
    }
  });

  test('running covers the starting family plus running', () => {
    for (const status of ['queued', 'branching', 'provisioning', 'running'] as const) {
      expect(matchesStatusFilters(makeSession({ status }), ['running'])).toBe(true);
    }
    expect(matchesStatusFilters(makeSession({ status: 'completed' }), ['running'])).toBe(false);
  });

  test('several selected values are ORed', () => {
    expect(matchesStatusFilters(makeSession({ status: 'completed' }), ['done', 'failed'])).toBe(
      true,
    );
    expect(matchesStatusFilters(makeSession({ status: 'failed' }), ['done', 'failed'])).toBe(true);
    expect(matchesStatusFilters(makeSession({ status: 'stopped' }), ['done', 'failed'])).toBe(
      false,
    );
  });

  test('reads the lifecycle, never the review overlay', () => {
    expect(matchesStatusFilters(makeSession({ status: 'running' }), ['running'])).toBe(true);
  });
});

describe('matchesSourceFilters', () => {
  test('an empty array matches everything', () => {
    expect(matchesSourceFilters(makeSession(), [], testUiTranslator)).toBe(true);
    expect(
      matchesSourceFilters(makeSession({ metadata: { source: 'slack' } }), [], testUiTranslator),
    ).toBe(true);
  });

  test('mine and shared split chats by ownership', () => {
    expect(matchesSourceFilters(makeSession({ is_owner: true }), ['mine'], testUiTranslator)).toBe(
      true,
    );
    expect(matchesSourceFilters(makeSession({ is_owner: false }), ['mine'], testUiTranslator)).toBe(
      false,
    );
    expect(
      matchesSourceFilters(makeSession({ is_owner: false }), ['shared'], testUiTranslator),
    ).toBe(true);
  });

  test('shared ownership is independent of the session source', () => {
    const scheduled = makeSession({
      is_owner: false,
      metadata: { trigger_source: 'cron', trigger_type: 'cron' },
    });
    expect(sessionIsShared(scheduled)).toBe(true);
    expect(matchesSourceFilters(scheduled, ['shared'], testUiTranslator)).toBe(true);
  });

  test('own and legacy sessions use the unmarked default state', () => {
    expect(sessionIsShared(makeSession({ is_owner: true }))).toBe(false);
    expect(sessionIsShared(makeSession())).toBe(false);
  });

  test('unknown ownership counts as mine so nothing is silently hidden', () => {
    expect(matchesSourceFilters(makeSession(), ['mine'], testUiTranslator)).toBe(true);
  });

  test('automation sources match their kind', () => {
    const slack = makeSession({ metadata: { source: 'slack' } });
    expect(matchesSourceFilters(slack, ['slack'], testUiTranslator)).toBe(true);
    expect(matchesSourceFilters(slack, ['email'], testUiTranslator)).toBe(false);
    expect(matchesSourceFilters(slack, ['mine', 'slack'], testUiTranslator)).toBe(true);
  });

  test('telegram matches its own kind only', () => {
    const telegram = makeSession({ metadata: { source: 'telegram' } });
    expect(matchesSourceFilters(telegram, ['telegram'], testUiTranslator)).toBe(true);
    expect(matchesSourceFilters(telegram, ['slack'], testUiTranslator)).toBe(false);
  });
});

/**
 * Sub-sessions visibly reordered themselves in the sidebar while the user was
 * looking at the list. They sort newest-first on `updated_at`, and a child
 * whose timestamp is missing collapses to `0` — so every such child TIED, and
 * `Array.prototype.sort` then preserved whatever order the sandbox listing
 * happened to arrive in. That order is re-derived on each refetch, and the
 * snapshot writer treats a pure reorder as a change worth persisting, so the
 * churn reached every client.
 *
 * Ties need a deterministic tiebreak. Ids are stable and unique, so they are it.
 */
describe('directSubsessions ordering', () => {
  const parent = (children: Array<{ id: string; updated_at?: number }>) =>
    ({
      opencode_session_id: 'root',
      opencode_sessions: [
        { id: 'root', parent_id: null },
        ...children.map((c) => ({ ...c, parent_id: 'root' })),
      ],
    }) as never;

  test('newest first when the timestamps differ', () => {
    const out = directSubsessions(
      parent([
        { id: 'a', updated_at: 100 },
        { id: 'b', updated_at: 300 },
        { id: 'c', updated_at: 200 },
      ]),
    );
    expect(out.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  test('children with NO timestamp keep a stable, id-ordered sequence', () => {
    const forward = directSubsessions(parent([{ id: 'c' }, { id: 'a' }, { id: 'b' }]));
    const reversed = directSubsessions(parent([{ id: 'b' }, { id: 'a' }, { id: 'c' }]));
    expect(forward.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    // The same children in a different ARRIVAL order must render identically —
    // that is the whole bug.
    expect(reversed.map((s) => s.id)).toEqual(forward.map((s) => s.id));
  });

  test('equal timestamps tie-break on id rather than on arrival order', () => {
    const forward = directSubsessions(
      parent([
        { id: 'z', updated_at: 500 },
        { id: 'y', updated_at: 500 },
      ]),
    );
    const reversed = directSubsessions(
      parent([
        { id: 'y', updated_at: 500 },
        { id: 'z', updated_at: 500 },
      ]),
    );
    expect(forward.map((s) => s.id)).toEqual(['y', 'z']);
    expect(reversed.map((s) => s.id)).toEqual(forward.map((s) => s.id));
  });
});
