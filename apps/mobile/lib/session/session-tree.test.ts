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
  startedByForScope,
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
});
