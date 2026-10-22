import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  buildDrawerItems,
  childCountOf,
  isParentExpanded,
  normalizeSessionListFilter,
  rootRowsOnly,
  searchQueryParam,
  sessionStarter,
  sessionsInView,
  sessionsPageFilter,
  sessionsPageRows,
  startedByForScope,
  uniqueSessions,
} from './session-tree';

const make = (overrides: Record<string, unknown> = {}): ProjectSession =>
  ({
    session_id: 's1',
    project_id: 'p1',
    parent_session_id: null,
    initiator: null,
    created_by: null,
    metadata: {},
    ...overrides,
  }) as unknown as ProjectSession;

describe('startedByForScope', () => {
  test('maps each chip to its started_by value; All sends none', () => {
    expect(startedByForScope('all')).toBeUndefined();
    expect(startedByForScope('mine')).toBe('me');
    expect(startedByForScope('shared')).toBe('others');
    expect(startedByForScope('automated')).toBe('automated');
  });
});

describe('normalizeSessionListFilter / searchQueryParam', () => {
  test('an empty filter is the legacy key; q is trimmed and capped at 200', () => {
    expect(normalizeSessionListFilter(undefined)).toEqual({});
    expect(normalizeSessionListFilter({ q: '   ' })).toEqual({});
    expect(normalizeSessionListFilter({ parent: 'root', startedBy: 'me', q: ' x ' })).toEqual({
      parent: 'root',
      startedBy: 'me',
      q: 'x',
    });
    expect(searchQueryParam('a'.repeat(300))).toHaveLength(200);
    expect(searchQueryParam('  ')).toBeUndefined();
  });
});

describe('rootRowsOnly', () => {
  test('drops any row that names a parent (never an orphan child)', () => {
    const rows = [make({ session_id: 'a' }), make({ session_id: 'b', parent_session_id: 'a' })];
    expect(rootRowsOnly(rows).map((r) => r.session_id)).toEqual(['a']);
  });
});

describe('childCountOf / isParentExpanded', () => {
  test('child_count defaults to 0', () => {
    expect(childCountOf(make())).toBe(0);
    expect(childCountOf(make({ child_count: 12 }))).toBe(12);
  });
  test('explicit choice wins; else the active parent or a child search match opens', () => {
    expect(isParentExpanded({ explicit: false, isActiveParent: true, searchMatch: 'child' })).toBe(false);
    expect(isParentExpanded({ explicit: true, isActiveParent: false, searchMatch: undefined })).toBe(true);
    expect(isParentExpanded({ explicit: undefined, isActiveParent: true, searchMatch: undefined })).toBe(true);
    expect(isParentExpanded({ explicit: undefined, isActiveParent: false, searchMatch: 'child' })).toBe(true);
    expect(isParentExpanded({ explicit: undefined, isActiveParent: false, searchMatch: 'self' })).toBe(false);
  });
});

describe('sessionStarter', () => {
  test('member: You only for the viewer, else the name', () => {
    const row = make({ initiator: { type: 'member', id: 'u1', label: 'Ada' } });
    expect(sessionStarter(row, 'u1')).toEqual({ type: 'member', label: 'You', icon: null });
    expect(sessionStarter(row, 'u2')).toEqual({ type: 'member', label: 'Ada', icon: null });
  });
  test('null initiator counts as a member of created_by', () => {
    expect(sessionStarter(make({ created_by: 'u1' }), 'u1').label).toBe('You');
    expect(sessionStarter(make({ created_by: 'u1' }), 'u2').label).toBe('Member');
  });
  test('trigger: slug with a schedule or webhook icon', () => {
    const cron = make({ initiator: { type: 'trigger', id: 'nightly', label: 'nightly' }, metadata: { source: 'trigger:cron' } });
    const hook = make({ initiator: { type: 'trigger', id: 'gh', label: 'gh' }, metadata: { source: 'trigger:webhook' } });
    expect(sessionStarter(cron, 'u1')).toEqual({ type: 'trigger', label: 'nightly', icon: 'clock' });
    expect(sessionStarter(hook, 'u1').icon).toBe('webhook');
  });
  test('channel, api and system', () => {
    expect(sessionStarter(make({ initiator: { type: 'channel', id: 'slack', label: 'Slack' } }), 'u').icon).toBe('slack');
    expect(sessionStarter(make({ initiator: { type: 'channel', id: 'email', label: 'Email' } }), 'u').icon).toBe('envelope');
    expect(sessionStarter(make({ initiator: { type: 'api', id: 'sa1', label: 'CI key' } }), 'u')).toEqual({
      type: 'api',
      label: 'CI key',
      icon: 'key',
    });
    expect(sessionStarter(make({ initiator: { type: 'system', id: 'system:x', label: 'Kortix' } }), 'u').label).toBe('Kortix');
  });
});

describe('buildDrawerItems', () => {
  const parent = make({ session_id: 'p', child_count: 3 });
  const leaf = make({ session_id: 'l' });
  const orphan = make({ session_id: 'o', parent_session_id: 'p' });
  const base = { open: true, hidden: false, hasMore: false };

  test('a collapsed parent has no children block; an expanded one gets it right after', () => {
    const sections = [{ id: 'sessions' as const, title: 'Sessions', rows: [parent, leaf], ...base }];
    expect(buildDrawerItems(sections, () => false).map((i) => i.kind)).toEqual(['header', 'root', 'root']);
    expect(buildDrawerItems(sections, () => true).map((i) => i.kind)).toEqual(['header', 'root', 'children', 'root']);
  });
  test('a leaf never gets a children block, and a child never renders as a root', () => {
    const items = buildDrawerItems([{ id: 'sessions', title: 'Sessions', rows: [leaf, orphan], ...base }], () => true);
    expect(items.map((i) => i.kind)).toEqual(['header', 'root']);
  });
  test('a collapsed section keeps only its header; a hidden one has none', () => {
    const items = buildDrawerItems(
      [
        { id: 'shared', title: 'Shared', rows: [leaf], ...base, hidden: true },
        { id: 'automated', title: 'Automated', rows: [leaf], ...base, open: false },
      ],
      () => false,
    );
    expect(items).toEqual([{ kind: 'header', section: 'automated', title: 'Automated', open: false }]);
  });
  test('"Show more" ends a paged section except Sessions (which scrolls)', () => {
    const shared = buildDrawerItems([{ id: 'shared', title: 'Shared', rows: [leaf], ...base, hasMore: true }], () => false);
    expect(shared.at(-1)).toEqual({ kind: 'more', section: 'shared' });
    const mine = buildDrawerItems([{ id: 'sessions', title: 'Sessions', rows: [leaf], ...base, hasMore: true }], () => false);
    expect(mine.some((i) => i.kind === 'more')).toBe(false);
  });
  // The three sections are three queries refreshed at different times. A
  // session whose starter changed (the viewer ran a shared session) sits in a
  // stale Shared page and in a fresh Mine page at once.
  test('a session cached in two sections renders once, in the first', () => {
    const items = buildDrawerItems(
      [
        { id: 'sessions', title: 'Sessions', rows: [leaf], ...base },
        { id: 'shared', title: 'Shared', rows: [leaf, parent], ...base },
      ],
      () => false,
    );
    const rows = items.filter((i) => i.kind === 'root').map((i) => `${i.section}:${i.session.session_id}`);
    expect(rows).toEqual(['sessions:l', 'shared:p']);
  });
});

describe('uniqueSessions', () => {
  test('drops a repeated session_id, keeping the first and the order', () => {
    const a = make({ session_id: 'a' });
    const b = make({ session_id: 'b' });
    const staleA = make({ session_id: 'a', title: 'stale' });
    expect(uniqueSessions([a, b, staleA])).toEqual([a, b]);
  });
});

// KRTX-2418: a person pins a session to the top of their own list, or archives
// it out of the list.
describe('pinned and archived views', () => {
  const pinned = make({ session_id: 'pin', pinned_at: '2026-10-15T10:00:00Z', archived_at: null });
  const archived = make({ session_id: 'arch', pinned_at: null, archived_at: '2026-10-15T10:00:00Z' });
  const plain = make({ session_id: 'plain', pinned_at: null, archived_at: null });
  const archivedChild = make({ session_id: 'arch-child', parent_session_id: 'p', pinned_at: null, archived_at: '2026-10-15T10:00:00Z' });
  // A server without the feature ignores `pinned=only` and answers the whole list.
  const legacy = make({ session_id: 'legacy' });

  test('the view key keeps `view`; the list key stays the legacy one', () => {
    expect(normalizeSessionListFilter({ parent: 'root', view: 'pinned' })).toEqual({ parent: 'root', view: 'pinned' });
    expect(normalizeSessionListFilter({ view: 'archived', q: '  ' })).toEqual({ view: 'archived' });
    expect(normalizeSessionListFilter({ parent: 'root' })).toEqual({ parent: 'root' });
  });

  test('a view shows only the rows that carry its stamp', () => {
    expect(sessionsInView([pinned, archived, plain, legacy], 'pinned').map((s) => s.session_id)).toEqual(['pin']);
    expect(sessionsInView([pinned, archived, plain, legacy], 'archived').map((s) => s.session_id)).toEqual(['arch']);
  });

  test('the Sessions page asks for top-level sessions, or with Archived on for every archived one', () => {
    expect(sessionsPageFilter({ scope: 'all', archived: false, q: 'fix' })).toEqual({ parent: 'root', startedBy: undefined, q: 'fix' });
    expect(sessionsPageFilter({ scope: 'mine', archived: true })).toEqual({ view: 'archived', startedBy: 'me', q: undefined });
    // No `parent`: an archived sub-agent session left its parent's children,
    // so the Archived view is the way back to it.
    expect(sessionsPageFilter({ scope: 'all', archived: true })).not.toHaveProperty('parent');
  });

  test('the Sessions page rows: roots for the list, archived rows (children too) for Archived', () => {
    expect(sessionsPageRows([plain, archivedChild], false).map((s) => s.session_id)).toEqual(['plain']);
    expect(sessionsPageRows([plain, archived, archivedChild, legacy], true).map((s) => s.session_id)).toEqual([
      'arch',
      'arch-child',
    ]);
  });

  const base = { open: true, hidden: false, hasMore: false };
  const roots = (items: ReturnType<typeof buildDrawerItems>) =>
    items.filter((i) => i.kind === 'root').map((i) => `${i.section}:${i.session.session_id}`);

  test('Pinned comes first and a pinned session is not repeated in Sessions or Shared', () => {
    const items = buildDrawerItems(
      [
        { id: 'pinned', title: 'Pinned', rows: [pinned], ...base },
        { id: 'sessions', title: 'Sessions', rows: [plain, pinned], ...base },
        { id: 'shared', title: 'Shared', rows: [pinned], ...base },
      ],
      () => false,
    );
    expect(roots(items)).toEqual(['pinned:pin', 'sessions:plain']);
    expect(items[0]).toEqual({ kind: 'header', section: 'pinned', title: 'Pinned', open: true });
  });

  test('a collapsed Pinned keeps its rows out of Sessions too', () => {
    const items = buildDrawerItems(
      [
        { id: 'pinned', title: 'Pinned', rows: [pinned], ...base, open: false },
        { id: 'sessions', title: 'Sessions', rows: [plain, pinned], ...base },
      ],
      () => false,
    );
    expect(roots(items)).toEqual(['sessions:plain']);
  });

  test('Pinned lists a pinned sub-agent session; Sessions never lists a child', () => {
    const pinnedChild = make({ session_id: 'pin-child', parent_session_id: 'p', pinned_at: '2026-10-15T10:00:00Z' });
    const items = buildDrawerItems(
      [
        { id: 'pinned', title: 'Pinned', rows: [pinnedChild], ...base },
        { id: 'sessions', title: 'Sessions', rows: [orphanOf('p')], ...base },
      ],
      () => false,
    );
    expect(roots(items)).toEqual(['pinned:pin-child']);
  });

  test('Pinned ends with "Show more" while it has a next page', () => {
    const items = buildDrawerItems([{ id: 'pinned', title: 'Pinned', rows: [pinned], ...base, hasMore: true }], () => false);
    expect(items.at(-1)).toEqual({ kind: 'more', section: 'pinned' });
  });
});

function orphanOf(parent: string): ProjectSession {
  return make({ session_id: `child-of-${parent}`, parent_session_id: parent });
}
