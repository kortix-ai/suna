import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '../rest/projects-client/sessions';
import {
  SESSION_STATUS_FILTERS,
  UNTITLED_SESSION_LABEL,
  childCountOf,
  directSubsessions,
  groupSessionsByActivity,
  isParentExpanded,
  matchesSessionStatusFilters,
  rootRowsOnly,
  sessionDisplayTitle,
  sessionHasTitle,
  sessionLastActivityAt,
  sessionListViewState,
  sessionSearchParam,
  sessionSource,
  sessionStarter,
  shortRelative,
  shouldLoadMoreSessions,
  startedByForScope,
  starterSectionOf,
  stripChatMentionMarkup,
} from './session-list';

const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function s(id: string, over: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: id,
    name: null,
    custom_name: null,
    agent_name: 'default',
    status: 'completed',
    metadata: {},
    opencode_sessions: [],
    created_at: new Date(NOW - DAY).toISOString(),
    updated_at: new Date(NOW - DAY).toISOString(),
    ...over,
  } as ProjectSession;
}

describe('titles', () => {
  test('rename wins, then the server name, then legacy session_name, then the placeholder', () => {
    expect(sessionDisplayTitle(s('a', { custom_name: ' Mine ', name: 'Auto' }))).toBe('Mine');
    expect(sessionDisplayTitle(s('a', { name: 'Auto' }))).toBe('Auto');
    expect(sessionDisplayTitle(s('a', { metadata: { session_name: 'Legacy' } }))).toBe('Legacy');
    expect(sessionDisplayTitle(s('a'))).toBe(UNTITLED_SESSION_LABEL);
    expect(sessionHasTitle(s('a'))).toBe(false);
  });

  test('Teams mention markup never reaches a title, on either app', () => {
    expect(sessionDisplayTitle(s('a', { name: '<at>Kortix</at> fix the build' }))).toBe('fix the build');
    expect(stripChatMentionMarkup('a&nbsp;&nbsp;b')).toBe('a b');
    expect(sessionDisplayTitle(s('a', { name: '<at>Kortix</at>' }))).toBe(UNTITLED_SESSION_LABEL);
  });
});

describe('sessionLastActivityAt (epoch ms)', () => {
  test('the newer of the prompt stamp and the conversation snapshot wins over bookkeeping', () => {
    const at = sessionLastActivityAt(
      s('a', {
        updated_at: new Date(NOW).toISOString(),
        metadata: { last_activity_at: new Date(NOW - 2 * HOUR).toISOString() },
        opencode_sessions: [{ id: 'o', updated_at: NOW - HOUR } as never],
      }),
    );
    expect(at).toBe(NOW - HOUR);
  });

  test('a malformed stamp is ignored; then updated_at, created_at, 0', () => {
    expect(sessionLastActivityAt(s('a', { metadata: { last_activity_at: 'nope' }, updated_at: new Date(NOW).toISOString() }))).toBe(NOW);
    expect(sessionLastActivityAt(s('a', { updated_at: 'garbage', created_at: new Date(NOW - HOUR).toISOString() }))).toBe(NOW - HOUR);
    expect(sessionLastActivityAt(s('a', { updated_at: '', created_at: '' }))).toBe(0);
  });
});

test('shortRelative buckets', () => {
  expect(shortRelative(NOW + 1000, NOW)).toBe('now');
  expect(shortRelative(NOW - 5 * 60_000, NOW)).toBe('5m');
  expect(shortRelative(NOW - 3 * HOUR, NOW)).toBe('3h');
  expect(shortRelative(NOW - 2 * DAY, NOW)).toBe('2d');
  expect(shortRelative(NOW - 60 * DAY, NOW)).toBe('2mo');
  expect(shortRelative(NOW - 400 * DAY, NOW)).toBe('1y');
});

test('sessionSource classifies a trigger fire by its trigger kind', () => {
  expect(sessionSource(s('a', { metadata: { source: 'slack' } })).kind).toBe('slack');
  expect(sessionSource(s('a', { metadata: { trigger_source: 'manual', trigger_type: 'cron', trigger_slug: 'd' } }))).toEqual({
    kind: 'schedule',
    triggerSlug: 'd',
  });
  expect(sessionSource(s('a', { metadata: { trigger_source: 'webhook' } })).kind).toBe('webhook');
  expect(sessionSource(s('a')).kind).toBe('chat');
});

describe('sessionStarter', () => {
  test('a member initiator is "You" only for the viewer', () => {
    const initiator = { type: 'member', id: 'u1', label: 'Ada' } as const;
    expect(sessionStarter(s('a', { initiator }), 'u1')).toMatchObject({ type: 'member', label: 'You', isViewer: true });
    expect(sessionStarter(s('a', { initiator }), 'u2')).toMatchObject({ label: 'Ada', isViewer: false });
  });

  test('no initiator (unclassified row): the owner, viewer-relative through is_owner', () => {
    expect(sessionStarter(s('a', { created_by: 'u1', is_owner: true }), null)).toMatchObject({ label: 'You', isViewer: true });
    expect(sessionStarter(s('a', { created_by: 'u2', is_owner: false, owner_email: 'b@example.test' }), 'u1')).toMatchObject({
      label: 'b@example.test',
      isViewer: false,
    });
    expect(sessionStarter(s('a', { is_owner: false }), 'u1').label).toBe('Member');
  });

  test('automated starters carry a label and an icon hint', () => {
    expect(
      sessionStarter(s('a', { initiator: { type: 'trigger', id: 'nightly', label: null }, metadata: { trigger_source: 'cron' } }), 'u1'),
    ).toMatchObject({ type: 'trigger', label: 'nightly', icon: 'schedule' });
    expect(sessionStarter(s('a', { initiator: { type: 'trigger', id: 'gh', label: 'GitHub push' } }), 'u1')).toMatchObject({
      label: 'GitHub push',
      icon: 'trigger',
    });
    expect(sessionStarter(s('a', { initiator: { type: 'channel', id: 'slack', label: null } }), 'u1').icon).toBe('slack');
    expect(sessionStarter(s('a', { initiator: { type: 'api', id: 'sa1', label: 'CI key' } }), 'u1').icon).toBe('api');
    expect(sessionStarter(s('a', { initiator: { type: 'system', id: null, label: null } }), 'u1').label).toBe('Kortix');
  });

  test('labels are injectable for a localized host', () => {
    const labels = { you: 'Du', member: 'Mitglied', system: 'System' };
    expect(sessionStarter(s('a', { is_owner: true }), null, labels).label).toBe('Du');
  });

  test('starterSectionOf: own runs stay in Sessions, others are Shared, automated runs are Automated', () => {
    expect(starterSectionOf(s('a', { initiator: { type: 'member', id: 'u1', label: null } }), 'u1')).toBeNull();
    expect(starterSectionOf(s('a', { initiator: { type: 'member', id: 'u2', label: null } }), 'u1')).toBe('shared');
    expect(starterSectionOf(s('a', { initiator: { type: 'trigger', id: 't', label: null } }), 'u1')).toBe('automated');
    expect(starterSectionOf(s('a', { is_owner: false }), 'u1')).toBe('shared');
  });
});

describe('status filter', () => {
  test('Running covers starting; Needs you is its own match and does not hide the lifecycle', () => {
    expect(SESSION_STATUS_FILTERS).toEqual(['needs-you', 'running', 'done', 'stopped', 'failed', 'legacy']);
    expect(matchesSessionStatusFilters(s('a', { status: 'provisioning' }), ['running'])).toBe(true);
    expect(matchesSessionStatusFilters(s('a', { status: 'running' }), ['needs-you'], 2)).toBe(true);
    expect(matchesSessionStatusFilters(s('a', { status: 'running' }), ['running'], 2)).toBe(true);
    expect(matchesSessionStatusFilters(s('a', { status: 'running' }), ['needs-you'], 0)).toBe(false);
    expect(matchesSessionStatusFilters(s('a'), [])).toBe(true);
  });
});

describe('scope and search params', () => {
  test('a scope maps to started_by; all sends none', () => {
    expect(startedByForScope('mine')).toBe('me');
    expect(startedByForScope('shared')).toBe('others');
    expect(startedByForScope('automated')).toBe('automated');
    expect(startedByForScope('all')).toBeUndefined();
  });

  test('the search param is trimmed, capped at 200, and absent when blank', () => {
    expect(sessionSearchParam('  hi ')).toBe('hi');
    expect(sessionSearchParam('   ')).toBeUndefined();
    expect(sessionSearchParam('x'.repeat(300))).toHaveLength(200);
  });
});

describe('tree', () => {
  test('rootRowsOnly drops rows that name a parent', () => {
    expect(rootRowsOnly([s('a'), s('b', { parent_session_id: 'a' })]).map((x) => x.session_id)).toEqual(['a']);
  });

  test('childCountOf clamps garbage to 0', () => {
    expect(childCountOf(s('a', { child_count: 3 }))).toBe(3);
    expect(childCountOf(s('a', { child_count: -1 }))).toBe(0);
    expect(childCountOf(s('a', { child_count: Number.NaN }))).toBe(0);
    expect(childCountOf(s('a'))).toBe(0);
  });

  test('the explicit choice wins; otherwise the active parent or a child search match opens it', () => {
    expect(isParentExpanded({ explicit: false, isActiveParent: true, searchMatch: 'child' })).toBe(false);
    expect(isParentExpanded({ explicit: undefined, isActiveParent: true, searchMatch: undefined })).toBe(true);
    expect(isParentExpanded({ explicit: undefined, isActiveParent: false, searchMatch: 'child' })).toBe(true);
    expect(isParentExpanded({ explicit: undefined, isActiveParent: false, searchMatch: 'self' })).toBe(false);
  });
});

test('groupSessionsByActivity: newest first into local-day buckets, empty ones dropped', () => {
  const today = s('today', { metadata: { last_activity_at: new Date(NOW - HOUR).toISOString() } });
  const yesterday = s('yday', { metadata: { last_activity_at: new Date(NOW - DAY).toISOString() } });
  const old = s('old', { metadata: { last_activity_at: new Date(NOW - 30 * DAY).toISOString() } });
  const input = [old, today, yesterday];
  const grouped = groupSessionsByActivity(input, NOW);
  expect(grouped.sections.map((x) => [x.id, x.label, x.sessions.map((y) => y.session_id)])).toEqual([
    ['today', 'Today', ['today']],
    ['yesterday', 'Yesterday', ['yday']],
    ['older', 'Older', ['old']],
  ]);
  expect(grouped.showHeaders).toBe(true);
  expect(input.map((x) => x.session_id)).toEqual(['old', 'today', 'yday']);
  expect(groupSessionsByActivity([today], NOW).showHeaders).toBe(false);
});

test('directSubsessions: non-archived children of the root, newest first, ties on id', () => {
  const session = s('a', {
    opencode_session_id: 'root',
    opencode_sessions: [
      { id: 'root', parent_id: null },
      { id: 'c2', parent_id: 'root', updated_at: 5 },
      { id: 'c1', parent_id: 'root', updated_at: 5 },
      { id: 'gone', parent_id: 'root', archived_at: 1 },
      { id: 'deep', parent_id: 'c1' },
    ] as never,
  });
  expect(directSubsessions(session).map((x) => x.id)).toEqual(['c1', 'c2']);
});

describe('view state and paging', () => {
  test('data wins over an error; empty wins over no matches unless the server filtered', () => {
    expect(sessionListViewState({ hasData: false, isError: true, totalCount: 0, visibleCount: 0 })).toBe('error');
    expect(sessionListViewState({ hasData: false, isError: false, totalCount: 0, visibleCount: 0 })).toBe('loading');
    expect(sessionListViewState({ hasData: true, isError: true, totalCount: 0, visibleCount: 0 })).toBe('empty');
    expect(sessionListViewState({ hasData: true, isError: false, totalCount: 0, visibleCount: 0, serverFiltered: true })).toBe(
      'no-matches',
    );
    expect(sessionListViewState({ hasData: true, isError: false, totalCount: 3, visibleCount: 0 })).toBe('no-matches');
    expect(sessionListViewState({ hasData: true, isError: false, totalCount: 3, visibleCount: 1 })).toBe('content');
  });

  test('load more only with a next page and nothing in flight', () => {
    expect(shouldLoadMoreSessions({ hasNextPage: true, isFetchingNextPage: false, isRefreshing: false })).toBe(true);
    expect(shouldLoadMoreSessions({ hasNextPage: true, isFetchingNextPage: true, isRefreshing: false })).toBe(false);
    expect(shouldLoadMoreSessions({ hasNextPage: false, isFetchingNextPage: false, isRefreshing: false })).toBe(false);
  });
});
