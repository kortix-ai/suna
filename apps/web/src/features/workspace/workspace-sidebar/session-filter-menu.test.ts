import { describe, expect, test } from 'bun:test';

import type { WorkspaceSession } from '@kortix/sdk';

import {
  resolveRenderedSectionIds,
  resolveShowOptions,
  resolveSourceFacetOptions,
  resolveStatusFacetOptions,
} from './session-filter-menu';

function makeSession(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    session_id: 's1',
    workspace_id: 'p1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
    custom_name: null,
    name: null,
    branch_name: null,
    metadata: null,
    opencode_sessions: [],
    ...overrides,
  } as unknown as WorkspaceSession;
}

const running = (id: string) => makeSession({ session_id: id, status: 'running' });
const done = (id: string) => makeSession({ session_id: id, status: 'completed' });
const failed = (id: string) => makeSession({ session_id: id, status: 'failed' });
const slack = (id: string, status: WorkspaceSession['status'] = 'running') =>
  makeSession({ session_id: id, status, metadata: { source: 'slack' } });
const email = (id: string, status: WorkspaceSession['status'] = 'running') =>
  makeSession({ session_id: id, status, metadata: { source: 'email' } });

describe('resolveStatusFacetOptions', () => {
  test('counts equal what would render if the option were the only status selected', () => {
    const sessions = [running('a'), running('b'), done('c'), failed('d')];
    const options = resolveStatusFacetOptions(sessions, [], []);
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
    const options = resolveStatusFacetOptions(sessions, [], []);
    expect(options.map((o) => o.value)).toEqual(['running']);
  });

  test('the active option stays listed at count 0', () => {
    // Status=failed selected, but Source=slack facet has zero failed sessions.
    const sessions = [slack('a', 'running'), email('b', 'failed')];
    const options = resolveStatusFacetOptions(sessions, ['failed'], ['slack']);
    const failedOption = options.find((o) => o.value === 'failed');
    expect(failedOption).toBeDefined();
    expect(failedOption?.count).toBe(0);
  });

  test('counts are faceted by the Source filter', () => {
    const sessions = [slack('a', 'running'), slack('b', 'failed'), email('c', 'running')];
    const options = resolveStatusFacetOptions(sessions, [], ['slack']);
    const byValue = Object.fromEntries(options.map((o) => [o.value, o.count]));
    // Only the two slack sessions pass the Source facet.
    expect(byValue.running).toBe(1);
    expect(byValue.failed).toBe(1);
  });

  test('no sessions: no options', () => {
    expect(resolveStatusFacetOptions([], [], [])).toEqual([]);
  });
});

describe('resolveSourceFacetOptions', () => {
  test('counts are faceted by the Status filter', () => {
    const sessions = [slack('a', 'running'), slack('b', 'failed'), email('c', 'running')];
    const options = resolveSourceFacetOptions(sessions, ['running'], []);
    const byValue = Object.fromEntries(options.map((o) => [o.value, o.count]));
    // Only the two running sessions pass the Status facet.
    expect(byValue.slack).toBe(1);
    expect(byValue.email).toBe(1);
    expect(byValue.mine).toBeUndefined();
  });

  test('the active option stays listed at count 0', () => {
    const sessions = [slack('a', 'failed')];
    const options = resolveSourceFacetOptions(sessions, ['running'], ['email']);
    const emailOption = options.find((o) => o.value === 'email');
    expect(emailOption).toBeDefined();
    expect(emailOption?.count).toBe(0);
  });

  test('mine and shared split ownership', () => {
    const mine = makeSession({ session_id: 'a', is_owner: true });
    const shared = makeSession({ session_id: 'b', is_owner: false });
    const options = resolveSourceFacetOptions([mine, shared], [], []);
    const byValue = Object.fromEntries(options.map((o) => [o.value, o.count]));
    expect(byValue.mine).toBe(1);
    expect(byValue.shared).toBe(1);
  });

  test('telegram is a listed facet option', () => {
    // Only protected by tsc before this test: if SESSION_SOURCE_FILTERS ever
    // drops its telegram entry, 'telegram' silently stops being an option here
    // even though matchesSourceFilters still recognizes the kind.
    const sessions = [makeSession({ session_id: 'a', metadata: { source: 'telegram' } })];
    const options = resolveSourceFacetOptions(sessions, [], []);
    expect(options.map((o) => o.value)).toContain('telegram');
  });
});

describe('resolveShowOptions', () => {
  test('lists the sections of the CURRENT grouping mode only', () => {
    const sessions = [running('a'), done('b')];
    const statusShow = resolveShowOptions(sessions, 'status');
    expect(statusShow.map((o) => o.id)).toEqual(['running', 'recent']);

    const sourceShow = resolveShowOptions(sessions, 'source');
    expect(sourceShow.map((o) => o.id)).toEqual(['chat']);
  });

  test('ignores hidden-section state so a hidden section can be turned back on', () => {
    // resolveShowOptions has no hiddenSections parameter at all: a section the
    // user hid still has to appear here so Show can offer its checkbox back.
    // resolveRenderedSectionIds, by contrast, DOES take hiddenSections and
    // drops a hidden section from the render list — that asymmetry is the
    // whole point of the two functions existing separately.
    const sessions = [running('a'), done('b')];
    const show = resolveShowOptions(sessions, 'status').map((o) => o.id);
    const rendered = resolveRenderedSectionIds(sessions, 'status', 'activity', ['running']);
    expect(show).toEqual(['running', 'recent']);
    expect(rendered).toEqual(['recent']);
    expect(show).not.toEqual(rendered);
  });

  test('no sessions: no sections', () => {
    expect(resolveShowOptions([], 'status')).toEqual([]);
  });

  test('needs-you appears once a review count is threaded through', () => {
    const sessions = [running('a')];
    // Default {} — the earlier defect: needs-you can never surface.
    expect(resolveShowOptions(sessions, 'status').map((o) => o.id)).toEqual(['running']);
    // Real review data — needs-you is listed and offerable in Show.
    expect(resolveShowOptions(sessions, 'status', { a: 1 }).map((o) => o.id)).toEqual([
      'needs-you',
    ]);
  });
});

describe('resolveRenderedSectionIds', () => {
  test('excludes sections currently hidden', () => {
    const sessions = [running('a'), done('b')];
    const ids = resolveRenderedSectionIds(sessions, 'status', 'activity', ['running']);
    expect(ids).toEqual(['recent']);
  });

  test('matches what Show would offer when nothing is hidden', () => {
    const sessions = [running('a'), done('b')];
    const rendered = resolveRenderedSectionIds(sessions, 'status', 'activity', []);
    const shown = resolveShowOptions(sessions, 'status').map((o) => o.id);
    expect(rendered).toEqual(shown);
  });

  test('needs-you is reachable by Collapse all once a review count is threaded through', () => {
    const sessions = [running('a'), done('b')];
    // Default {} — the earlier defect: Collapse all silently left needs-you
    // expanded because it was never in the rendered id list to begin with.
    expect(resolveRenderedSectionIds(sessions, 'status', 'activity', [])).toEqual([
      'running',
      'recent',
    ]);
    expect(resolveRenderedSectionIds(sessions, 'status', 'activity', [], { a: 1 })).toEqual([
      'needs-you',
      'recent',
    ]);
  });
});
