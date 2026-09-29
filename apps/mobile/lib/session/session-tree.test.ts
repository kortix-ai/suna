import { describe, expect, test } from 'bun:test';

import { sessionStarter } from '@kortix/sdk';

import type { ProjectSession } from '@/lib/projects/projects-client';
import { buildDrawerItems } from './session-tree';

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

describe('sessionStarter (SDK) for rows the backfill left unclassified', () => {
  // Fix: mobile read an unclassified row by `created_by` alone, so the
  // viewer's own row without an initiator read "Member". The SDK falls back
  // to `is_owner`, then to the owner's name.
  test('the viewer\'s own row reads "You" through is_owner', () => {
    expect(sessionStarter(make({ created_by: 'u1', is_owner: true }), 'u2').label).toBe('You');
  });
  test('another member\'s row reads their name, "Member" only without one', () => {
    expect(sessionStarter(make({ is_owner: false, owner_name: 'Ada' }), 'u2').label).toBe('Ada');
    expect(sessionStarter(make({ is_owner: false }), 'u2').label).toBe('Member');
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
