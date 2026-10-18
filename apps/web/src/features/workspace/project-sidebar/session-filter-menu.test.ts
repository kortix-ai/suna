import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';

import type { ProjectSession } from '@kortix/sdk';

import { testUiTranslator } from '@/i18n/test-translator';
import enMessages from '../../../../translations/en.json';
import { resolveSectionLabels } from './session-section-labels';
import {
  resolveRenderedSectionIds,
  resolveShowOptions,
  resolveSourceFacetOptions,
  resolveStatusFacetOptions,
} from './session-filter-menu';

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
    opencode_sessions: [],
    ...overrides,
  } as unknown as ProjectSession;
}

const running = (id: string) => makeSession({ session_id: id, status: 'running' });
const done = (id: string) => makeSession({ session_id: id, status: 'completed' });
const failed = (id: string) => makeSession({ session_id: id, status: 'failed' });
const slack = (id: string, status: ProjectSession['status'] = 'running') =>
  makeSession({ session_id: id, status, metadata: { source: 'slack' } });
const email = (id: string, status: ProjectSession['status'] = 'running') =>
  makeSession({ session_id: id, status, metadata: { source: 'email' } });

describe('resolveStatusFacetOptions', () => {
  test('counts equal what would render if the option were the only status selected', () => {
    const sessions = [running('a'), running('b'), done('c'), failed('d')];
    const options = resolveStatusFacetOptions(sessions, [], [], testUiTranslator);
    const byValue = Object.fromEntries(options.map((o) => [o.value, o.count]));
    expect(byValue.running).toBe(2);
    expect(byValue.done).toBe(1);
    expect(byValue.failed).toBe(1);
    // Actually selecting "running" renders exactly this many rows.
    expect(sessions.filter((s) => s.status === 'running' || s.status === 'queued').length).toBe(
      byValue.running,
    );
  });

  test('an option present at zero and not selected is dropped', () => {
    const sessions = [running('a')];
    const options = resolveStatusFacetOptions(sessions, [], [], testUiTranslator);
    expect(options.map((o) => o.value)).toEqual(['running']);
  });

  test('the active option stays listed at count 0', () => {
    // Status=failed selected, but Source=slack facet has zero failed sessions.
    const sessions = [slack('a', 'running'), email('b', 'failed')];
    const options = resolveStatusFacetOptions(sessions, ['failed'], ['slack'], testUiTranslator);
    const failedOption = options.find((o) => o.value === 'failed');
    expect(failedOption).toBeDefined();
    expect(failedOption?.count).toBe(0);
  });

  test('counts are faceted by the Source filter', () => {
    const sessions = [slack('a', 'running'), slack('b', 'failed'), email('c', 'running')];
    const options = resolveStatusFacetOptions(sessions, [], ['slack'], testUiTranslator);
    const byValue = Object.fromEntries(options.map((o) => [o.value, o.count]));
    // Only the two slack sessions pass the Source facet.
    expect(byValue.running).toBe(1);
    expect(byValue.failed).toBe(1);
  });

  test('no sessions: no options', () => {
    expect(resolveStatusFacetOptions([], [], [], testUiTranslator)).toEqual([]);
  });
});

describe('resolveSourceFacetOptions', () => {
  test('counts are faceted by the Status filter', () => {
    const sessions = [slack('a', 'running'), slack('b', 'failed'), email('c', 'running')];
    const options = resolveSourceFacetOptions(sessions, ['running'], [], testUiTranslator);
    const byValue = Object.fromEntries(options.map((o) => [o.value, o.count]));
    // Only the two running sessions pass the Status facet.
    expect(byValue.slack).toBe(1);
    expect(byValue.email).toBe(1);
  });

  test('the active option stays listed at count 0', () => {
    const sessions = [slack('a', 'failed')];
    const options = resolveSourceFacetOptions(sessions, ['running'], ['email'], testUiTranslator);
    const emailOption = options.find((o) => o.value === 'email');
    expect(emailOption).toBeDefined();
    expect(emailOption?.count).toBe(0);
  });

  test('shared counts sessions the viewer does not own', () => {
    const mine = makeSession({ session_id: 'a', is_owner: true });
    const shared = makeSession({ session_id: 'b', is_owner: false });
    const options = resolveSourceFacetOptions([mine, shared], [], [], testUiTranslator);
    const byValue = Object.fromEntries(options.map((o) => [o.value, o.count]));
    expect(byValue.mine).toBeUndefined();
    expect(byValue.shared).toBe(1);
  });

  test('telegram is a listed facet option', () => {
    // Only protected by tsc before this test: if SESSION_SOURCE_FILTERS ever
    // drops its telegram entry, 'telegram' silently stops being an option here
    // even though matchesSourceFilters still recognizes the kind.
    const sessions = [makeSession({ session_id: 'a', metadata: { source: 'telegram' } })];
    const options = resolveSourceFacetOptions(sessions, [], [], testUiTranslator);
    expect(options.map((o) => o.value)).toContain('telegram');
  });
});

describe('resolveShowOptions', () => {
  test('lists the sections of the CURRENT grouping mode only', () => {
    const sessions = [running('a'), done('b')];
    const statusShow = resolveShowOptions(sessions, 'status', testUiTranslator);
    expect(statusShow.map((o) => o.id)).toEqual(['running', 'recent']);

    const sourceShow = resolveShowOptions(sessions, 'source', testUiTranslator);
    expect(sourceShow.map((o) => o.id)).toEqual(['chat']);
  });

  test('ignores hidden-section state so a hidden section can be turned back on', () => {
    // resolveShowOptions has no hiddenSections parameter at all: a section the
    // user hid still has to appear here so Show can offer its checkbox back.
    // resolveRenderedSectionIds, by contrast, DOES take hiddenSections and
    // drops a hidden section from the render list — that asymmetry is the
    // whole point of the two functions existing separately.
    const sessions = [running('a'), done('b')];
    const show = resolveShowOptions(sessions, 'status', testUiTranslator).map((o) => o.id);
    const rendered = resolveRenderedSectionIds(
      sessions,
      'status',
      'activity',
      ['running'],
      testUiTranslator,
    );
    expect(show).toEqual(['running', 'recent']);
    expect(rendered).toEqual(['recent']);
    expect(show).not.toEqual(rendered);
  });

  test('no sessions: no sections', () => {
    expect(resolveShowOptions([], 'status', testUiTranslator)).toEqual([]);
  });

  test('needs-you appears once a review count is threaded through', () => {
    const sessions = [running('a')];
    // Default {} — the earlier defect: needs-you can never surface.
    expect(resolveShowOptions(sessions, 'status', testUiTranslator).map((o) => o.id)).toEqual([
      'running',
    ]);
    // Real review data — needs-you is listed and offerable in Show.
    expect(
      resolveShowOptions(sessions, 'status', testUiTranslator, { a: 1 }).map((o) => o.id),
    ).toEqual(['needs-you']);
  });
});

describe('resolveRenderedSectionIds', () => {
  test('excludes sections currently hidden', () => {
    const sessions = [running('a'), done('b')];
    const ids = resolveRenderedSectionIds(
      sessions,
      'status',
      'activity',
      ['running'],
      testUiTranslator,
    );
    expect(ids).toEqual(['recent']);
  });

  test('matches what Show would offer when nothing is hidden', () => {
    const sessions = [running('a'), done('b')];
    const rendered = resolveRenderedSectionIds(
      sessions,
      'status',
      'activity',
      [],
      testUiTranslator,
    );
    const shown = resolveShowOptions(sessions, 'status', testUiTranslator).map((o) => o.id);
    expect(rendered).toEqual(shown);
  });

  test('needs-you is reachable by Collapse all once a review count is threaded through', () => {
    const sessions = [running('a'), done('b')];
    // Default {} — the earlier defect: Collapse all silently left needs-you
    // expanded because it was never in the rendered id list to begin with.
    expect(resolveRenderedSectionIds(sessions, 'status', 'activity', [], testUiTranslator)).toEqual(
      ['running', 'recent'],
    );
    expect(
      resolveRenderedSectionIds(sessions, 'status', 'activity', [], testUiTranslator, { a: 1 }),
    ).toEqual(['needs-you', 'recent']);
  });
});

describe('resolveSectionLabels', () => {
  // A translator over the real English catalog with `section.teams` overridden
  // to a sentinel. In English every section label equals its untranslated
  // fallback, so only a differing value can prove a row's label comes from the
  // translation path (`t('section.*')`) and not the raw catalog string.
  // `createTranslator` over the same catalog satisfies the structural
  // `{ (key: SectionLabelKey): string }` parameter — no provider, no cast.
  const SECTION_TEAMS_SENTINEL = 'Teams · localized';
  const localizedSidebarTranslator = createTranslator({
      locale: 'en',
      messages: {
        sidebar: {
          filter: {
            section: {
              ...enMessages.sidebar.filter.section,
              teams: SECTION_TEAMS_SENTINEL,
            },
          },
        },
      },
      namespace: 'sidebar.filter',
    });

  // One session per section across the four declared modes. Activity
  // fixtures are built from LOCAL calendar components relative to the run
  // date — `resolveShowOptions` cannot thread a `now` into `groupSessions`
  // (it uses the `Date.now()` default), so a fixed-date fixture would drift
  // out of its bucket as real days pass. Noon local always exists (no DST
  // gap crosses 12:00) and keeps each fixture inside its own calendar day:
  // today 12:00 → `today`, yesterday 12:00 → `yesterday`, 5 days back →
  // `week` (weekStart is 7 local midnights back; 5 days + 12 h stays inside),
  // 60 days back → `older`.
  const atLocalNoonDaysAgo = (id: string, daysAgo: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(12, 0, 0, 0);
    return makeSession({ session_id: id, created_at: d.toISOString() });
  };
  const ALL_SECTION_SESSIONS: ProjectSession[] = [
    makeSession({ session_id: 'status-review', status: 'completed' }), // needs-you
    running('status-running'), // running (+ chat in source mode)
    done('status-done'), // recent
    atLocalNoonDaysAgo('activity-today', 0),
    atLocalNoonDaysAgo('activity-yesterday', 1),
    atLocalNoonDaysAgo('activity-week', 5),
    atLocalNoonDaysAgo('activity-older', 60),
    makeSession({ session_id: 'source-slack', metadata: { source: 'slack' } }),
    makeSession({ session_id: 'source-telegram', metadata: { source: 'telegram' } }),
    makeSession({ session_id: 'source-teams', metadata: { source: 'teams' } }),
    makeSession({ session_id: 'source-email', metadata: { source: 'email' } }),
    makeSession({ session_id: 'source-schedule', metadata: { trigger_source: 'cron' } }),
    makeSession({ session_id: 'source-webhook', metadata: { trigger_source: 'webhook' } }),
    makeSession({ session_id: 'source-event', metadata: { trigger_source: 'event' } }),
    makeSession({ session_id: 'source-manual', metadata: { trigger_source: 'manual' } }),
    // source mode's 'chat' section: any session without source/trigger
    // metadata qualifies ('status-running' and friends).
  ];
  const REVIEW_COUNTS = { 'status-review': 1 };

  test('every section id the Show submenu can list has a localized entry', () => {
    const ids = new Set<string>();
    for (const mode of ['status', 'activity', 'source', 'none'] as const) {
      for (const option of resolveShowOptions(
        ALL_SECTION_SESSIONS,
        mode,
        testUiTranslator,
        REVIEW_COUNTS,
      )) {
        ids.add(option.id);
      }
    }
    // `owner` mode is excluded: its section ids are per-owner data keys
    // (`owner:<key>`) whose Show label is option.label itself — ownerSections
    // localizes those at the source, so a static map can never cover them.

    // Pin the four activity buckets explicitly: if a future change breaks the
    // run-date-relative fixtures (or bucketing drifts), the sweep would
    // silently narrow and stop covering `today`/`yesterday`/`week`/`older`.
    for (const bucket of ['today', 'yesterday', 'week', 'older'] as const) {
      expect(ids.has(bucket), `activity bucket ${bucket} must be swept`).toBe(true);
    }

    const labels = resolveSectionLabels(localizedSidebarTranslator);
    const missing = [...ids].filter((id) => !(id in labels));
    expect(missing).toEqual([]);
  });

  test("a Teams section's Show row renders the localized label, not the raw English catalog string", () => {
    // 'Teams' has no product-catalog translation key, so the option label the
    // fallback path renders is the raw English string in every locale — the
    // exact symptom the missing map entry produced.
    const [teamsOption] = resolveShowOptions(
      [makeSession({ metadata: { source: 'teams' } })],
      'source',
      testUiTranslator,
    );
    expect(teamsOption?.id).toBe('teams');
    expect(teamsOption?.label).toBe('Teams');

    const labels = resolveSectionLabels(localizedSidebarTranslator);
    expect(teamsOption && labels[teamsOption.id]).toBe(SECTION_TEAMS_SENTINEL);
  });
});
