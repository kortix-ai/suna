import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import type { ProjectSession } from '@/lib/projects/projects-client';

import {
  applyToSessionCache,
  createdSessionListRow,
  listStateAfter,
  mergeRenamed,
  renameInRows,
  sessionListView,
  sessionRowsOf,
  upsertIntoSessionCache,
  withoutSession,
  writeListState,
  writeSessionLists,
} from './session-cache-write';

/**
 * A rename, a delete and a new session used to reach the drawer and the
 * Sessions page only after the refetch that follows the server's answer.
 * These tests pin the writes that show them at once.
 */

const row = (session_id: string, extra: Partial<ProjectSession> = {}) =>
  ({ session_id, name: null, custom_name: null, ...extra }) as ProjectSession;

const paged = (...pages: ProjectSession[][]) => ({
  pages: pages.map((items, i) => ({
    items,
    next_cursor: i < pages.length - 1 ? `c${i + 1}` : null,
  })),
  pageParams: pages.map((_, i) => (i === 0 ? null : `c${i}`)),
});

type Paged = ReturnType<typeof paged>;
const ids = (cache: unknown) =>
  (cache as Paged).pages.map((page) => page.items.map((session) => session.session_id));

describe('applyToSessionCache', () => {
  test('updates a flat list', () => {
    const next = applyToSessionCache([row('a'), row('b')], (rows) => withoutSession(rows, 'b'));
    expect((next as ProjectSession[]).map((s) => s.session_id)).toEqual(['a']);
  });

  test('updates the page that holds the row; the other pages keep their identity', () => {
    const cached = paged([row('a')], [row('b')]);
    const next = applyToSessionCache(cached, (rows) => withoutSession(rows, 'b')) as Paged;
    expect(ids(next)).toEqual([['a'], []]);
    expect(next.pages[0]).toBe(cached.pages[0]);
    expect(next.pageParams).toBe(cached.pageParams);
  });

  test('a change that touches no row returns the cache by reference', () => {
    const cached = paged([row('a')], [row('b')]);
    expect(applyToSessionCache(cached, (rows) => withoutSession(rows, 'zzz'))).toBe(cached);
    const flat = [row('a')];
    expect(applyToSessionCache(flat, (rows) => withoutSession(rows, 'zzz'))).toBe(flat);
  });

  test('another shape, or nothing cached, is left as it is', () => {
    const other = { total: 3 };
    expect(applyToSessionCache(other, (rows) => rows.slice(1))).toBe(other);
    expect(applyToSessionCache(undefined, (rows) => rows.slice(1))).toBeUndefined();
  });

  // KRTX-2316: the by-id read caches ONE row under the same prefix.
  test('a single row (the by-id read) takes a rename; a delete or an insert of another session leaves it', () => {
    const one = row('a', { name: 'Old' });
    expect(applyToSessionCache<ProjectSession>(one, (rows) => renameInRows(rows, 'a', 'New'))).toMatchObject({ session_id: 'a', name: 'New' });
    expect(applyToSessionCache(one, (rows) => withoutSession(rows, 'a'))).toBe(one);
    expect(applyToSessionCache(one, (rows) => [row('b'), ...rows])).toBe(one);
    expect(applyToSessionCache<ProjectSession>(one, (rows) => renameInRows(rows, 'zzz', 'New'))).toBe(one);
  });
});

describe('sessionRowsOf', () => {
  test('the rows of a flat page, a paged list and a single row', () => {
    expect(sessionRowsOf([row('a'), row('b')]).map((s) => s.session_id)).toEqual(['a', 'b']);
    expect(sessionRowsOf(paged([row('a')], [row('b'), row('a')])).map((s) => s.session_id)).toEqual(['a', 'b']);
    expect(sessionRowsOf(row('a')).map((s) => s.session_id)).toEqual(['a']);
  });

  test('no rows in another entry under the prefix (message authors) or in nothing', () => {
    expect(sessionRowsOf({ authors: {} })).toEqual([]);
    expect(sessionRowsOf(undefined)).toEqual([]);
  });
});

describe('upsertIntoSessionCache', () => {
  test('a new session goes to the top of the FIRST page only', () => {
    const cached = paged([row('a')], [row('b')]);
    const next = upsertIntoSessionCache(cached, row('new')) as Paged;
    expect(ids(next)).toEqual([['new', 'a'], ['b']]);
    expect(next.pages[1]).toBe(cached.pages[1]);
  });

  test('a session already cached is replaced in place, on the page that holds it', () => {
    const cached = paged([row('a')], [row('b', { name: 'old' })]);
    const next = upsertIntoSessionCache(cached, row('b', { name: 'new' })) as Paged;
    expect(ids(next)).toEqual([['a'], ['b']]);
    expect(next.pages[1].items[0].name).toBe('new');
    expect(next.pages[0]).toBe(cached.pages[0]);
  });

  test('prepends to a flat list', () => {
    const next = upsertIntoSessionCache([row('a')], row('new')) as ProjectSession[];
    expect(next.map((s) => s.session_id)).toEqual(['new', 'a']);
  });

  test('the same row again, no page, or another shape: the cache by reference', () => {
    const same = row('a');
    const cached = paged([same]);
    expect(upsertIntoSessionCache(cached, same)).toBe(cached);
    const noPages = { pages: [], pageParams: [] };
    expect(upsertIntoSessionCache(noPages, row('new'))).toBe(noPages);
    const other = { total: 3 };
    expect(upsertIntoSessionCache(other, row('new'))).toBe(other);
  });
});

describe('rename', () => {
  test('a name sets custom_name and the display name, as the server answers', () => {
    const rows = [row('a'), row('b', { name: 'Auto title' })];
    const next = renameInRows(rows, 'b', 'Release notes');
    expect(next[1]).toMatchObject({ custom_name: 'Release notes', name: 'Release notes' });
    expect(next[0]).toBe(rows[0]);
  });

  test('an empty name clears the rename and leaves the display name to the server', () => {
    const rows = [row('a', { custom_name: 'Mine', name: 'Mine' })];
    expect(renameInRows(rows, 'a', '')[0]).toMatchObject({ custom_name: null, name: 'Mine' });
  });

  test('an unknown session or an unchanged name: the rows by reference', () => {
    const rows = [row('a', { custom_name: 'Mine', name: 'Mine' })];
    expect(renameInRows(rows, 'zzz', 'x')).toBe(rows);
    expect(renameInRows(rows, 'a', 'Mine')).toBe(rows);
  });

  test('the server’s answer merges name, custom_name and updated_at only', () => {
    const rows = [row('a', { owner_email: 'kept-owner', runtime_status: 'active' })];
    const answer = row('a', {
      name: 'Server name',
      custom_name: 'Server name',
      updated_at: '2026-09-26T12:00:00Z',
      owner_email: null,
      runtime_status: null,
    });
    expect(mergeRenamed(rows, answer)[0]).toMatchObject({
      name: 'Server name',
      custom_name: 'Server name',
      updated_at: '2026-09-26T12:00:00Z',
      owner_email: 'kept-owner',
      runtime_status: 'active',
    });
    expect(mergeRenamed(rows, row('zzz'))).toBe(rows);
  });
});

describe('createdSessionListRow', () => {
  const created = {
    session_id: 's-new',
    project_id: 'p-1',
    status: 'queued',
    created_at: '2026-09-26T12:00:00Z',
    updated_at: '2026-09-26T12:00:00Z',
    opencode_sessions: [],
    metadata: { name: 'Title', initial_prompt: 'the prompt text', session_start_timeline: {} },
  };

  test('a 201 row becomes a list row, without the metadata the list leaves out', () => {
    const listed = createdSessionListRow(created, 'p-1');
    expect(listed?.session_id).toBe('s-new');
    expect(listed?.metadata).toEqual({ name: 'Title' });
  });

  test('a row without list-omitted metadata is kept by reference', () => {
    const plain = { ...created, metadata: { name: 'Title' } };
    expect(createdSessionListRow(plain, 'p-1')).toBe(plain as unknown as ProjectSession);
  });

  test('a 202 "create queued" answer is not a row', () => {
    const accepted = { status: 'queued', command_id: 'cmd-1', session_id: 's-new', reason: null };
    expect(createdSessionListRow(accepted, 'p-1')).toBeNull();
  });

  test('another project’s row, or no object at all, is not listed here', () => {
    expect(createdSessionListRow(created, 'p-2')).toBeNull();
    expect(createdSessionListRow(undefined, 'p-1')).toBeNull();
    expect(createdSessionListRow('s-new', 'p-1')).toBeNull();
  });
});

describe('writeSessionLists over the real query client', () => {
  const FLAT = ['project-sessions', 'p-1'] as const;
  const PAGED = ['project-sessions', 'p-1', 'paged'] as const;

  test('a delete leaves the paged list at once, and its undo puts the row back', () => {
    const client = new QueryClient();
    const cached = paged([row('a'), row('b')], [row('c')]);
    client.setQueryData(PAGED, cached);

    const undo = writeSessionLists(client, [PAGED], (list) =>
      applyToSessionCache(list, (rows) => withoutSession(rows, 'b'))
    );
    expect(ids(client.getQueryData(PAGED))).toEqual([['a'], ['c']]);

    undo();
    // Equal, not identical: setQueryData shares structure with the current data.
    expect(client.getQueryData(PAGED) as unknown).toEqual(cached);
    client.clear();
  });

  test('a created session reaches both lists; a list not cached is not created', () => {
    const client = new QueryClient();
    client.setQueryData(PAGED, paged([row('a')]));

    writeSessionLists(client, [FLAT, PAGED], (list) => upsertIntoSessionCache(list, row('new')));

    expect(ids(client.getQueryData(PAGED))).toEqual([['new', 'a']]);
    expect(client.getQueryData(FLAT) as unknown).toBeUndefined();
    client.clear();
  });

  test('a change that touches nothing writes nothing, and its undo restores nothing', () => {
    const client = new QueryClient();
    const cached = paged([row('a')]);
    client.setQueryData(PAGED, cached, { updatedAt: 1 });

    const undo = writeSessionLists(client, [PAGED], (list) =>
      applyToSessionCache(list, (rows) => withoutSession(rows, 'zzz'))
    );
    undo();

    expect(client.getQueryData(PAGED) as unknown).toBe(cached);
    expect(client.getQueryState(PAGED)?.dataUpdatedAt).toBe(1);
    client.clear();
  });
});

// KRTX-2418: a person pins a session to the top of their own list, or archives
// it out of the list. The cached lists show it at once.
describe('pin and archive', () => {
  const NOW = '2026-10-15T12:00:00.000Z';
  const EARLIER = '2026-10-14T09:00:00.000Z';
  const KEYS = {
    flat: ['project-sessions', 'p-1'],
    list: ['project-sessions', 'p-1', 'paged', { parent: 'root', startedBy: 'me' }],
    legacyList: ['project-sessions', 'p-1', 'paged'],
    pinned: ['project-sessions', 'p-1', 'paged', { view: 'pinned' }],
    archived: ['project-sessions', 'p-1', 'paged', { view: 'archived', startedBy: 'me' }],
    children: ['project-sessions', 'p-1', 'children', 'parent-1', null],
    byId: ['project-sessions', 'p-1', 'session', 'a'],
    participants: ['project-sessions', 'p-1', 'participants', 'a'],
  } as const;

  test('the state a change leaves: archiving unpins, pinning unarchives, a repeat keeps the first time', () => {
    const plain = { pinned_at: null, archived_at: null };
    expect(listStateAfter(plain, { pinned: true }, NOW)).toEqual({ pinned_at: NOW, archived_at: null });
    expect(listStateAfter({ pinned_at: EARLIER, archived_at: null }, { pinned: true }, NOW)).toEqual({ pinned_at: EARLIER, archived_at: null });
    expect(listStateAfter({ pinned_at: EARLIER, archived_at: null }, { archived: true }, NOW)).toEqual({ pinned_at: null, archived_at: NOW });
    expect(listStateAfter({ pinned_at: null, archived_at: EARLIER }, { pinned: true }, NOW)).toEqual({ pinned_at: NOW, archived_at: null });
    expect(listStateAfter({ pinned_at: EARLIER, archived_at: null }, { pinned: false }, NOW)).toEqual(plain);
    expect(listStateAfter({ pinned_at: null, archived_at: EARLIER }, { archived: false }, NOW)).toEqual(plain);
    // A row without the fields (a server without the feature) reads as neither.
    expect(listStateAfter({}, { archived: true }, NOW)).toEqual({ pinned_at: null, archived_at: NOW });
  });

  test('what each cached entry lists', () => {
    expect(sessionListView(KEYS.list)).toBeNull();
    expect(sessionListView(KEYS.legacyList)).toBeNull();
    expect(sessionListView(KEYS.children)).toBeNull();
    expect(sessionListView(KEYS.pinned)).toBe('pinned');
    expect(sessionListView(KEYS.archived)).toBe('archived');
    expect(sessionListView(KEYS.flat)).toBeUndefined();
    expect(sessionListView(KEYS.byId)).toBeUndefined();
    expect(sessionListView(KEYS.participants)).toBeUndefined();
  });

  const archivedState = { pinned_at: null, archived_at: NOW };
  const pinnedState = { pinned_at: NOW, archived_at: null };
  const clearState = { pinned_at: null, archived_at: null };

  test('an archived row leaves the list, the children and the pinned view; it stays in lookups with its new state', () => {
    const list = paged([row('a', clearState), row('b', clearState)]);
    expect(ids(writeListState(list, KEYS.list, 'a', archivedState))).toEqual([['b']]);
    expect(ids(writeListState(list, KEYS.children, 'a', archivedState))).toEqual([['b']]);
    expect(ids(writeListState(paged([row('a', pinnedState)]), KEYS.pinned, 'a', archivedState))).toEqual([[]]);
    const flat = writeListState([row('a', clearState)], KEYS.flat, 'a', archivedState) as ProjectSession[];
    expect(flat.map((r) => [r.session_id, r.archived_at])).toEqual([['a', NOW]]);
    const byId = writeListState(row('a', clearState), KEYS.byId, 'a', archivedState) as ProjectSession;
    expect(byId.archived_at).toBe(NOW);
  });

  test('a pinned row stays in the list with its pin; it joins the pinned view on the refetch', () => {
    const list = writeListState(paged([row('a', clearState)]), KEYS.list, 'a', pinnedState) as Paged;
    expect(list.pages[0].items[0].pinned_at).toBe(NOW);
    const pinnedView = paged([row('x', pinnedState)]);
    expect(writeListState(pinnedView, KEYS.pinned, 'a', pinnedState)).toBe(pinnedView);
  });

  test('an unpinned row leaves the pinned view; an unarchived row leaves the archived view', () => {
    expect(ids(writeListState(paged([row('a', pinnedState), row('x', pinnedState)]), KEYS.pinned, 'a', clearState))).toEqual([['x']]);
    expect(ids(writeListState(paged([row('a', archivedState)]), KEYS.archived, 'a', clearState))).toEqual([[]]);
  });

  test('a cache without the session, or one with the same state, is returned by reference', () => {
    const list = paged([row('b', clearState)]);
    expect(writeListState(list, KEYS.list, 'a', archivedState)).toBe(list);
    const same = paged([row('a', pinnedState)]);
    expect(writeListState(same, KEYS.list, 'a', pinnedState)).toBe(same);
  });

  test('over the real query client: every cached entry at once, and the undo restores every one', () => {
    const client = new QueryClient();
    const list = paged([row('a', clearState), row('b', clearState)]);
    const pinnedView = paged([row('a', pinnedState)]);
    client.setQueryData(KEYS.list, list);
    client.setQueryData(KEYS.pinned, pinnedView);
    client.setQueryData(KEYS.byId, row('a', pinnedState));

    const undo = writeSessionLists(client, [KEYS.list, KEYS.pinned, KEYS.archived, KEYS.byId], (cached, key) =>
      writeListState(cached, key, 'a', archivedState)
    );
    expect(ids(client.getQueryData(KEYS.list))).toEqual([['b']]);
    expect(ids(client.getQueryData(KEYS.pinned))).toEqual([[]]);
    expect((client.getQueryData(KEYS.byId) as ProjectSession).archived_at).toBe(NOW);
    // Not cached: not created.
    expect(client.getQueryData(KEYS.archived) as unknown).toBeUndefined();

    undo();
    expect(client.getQueryData(KEYS.list) as unknown).toEqual(list);
    expect(client.getQueryData(KEYS.pinned) as unknown).toEqual(pinnedView);
    expect((client.getQueryData(KEYS.byId) as ProjectSession).pinned_at).toBe(NOW);
    client.clear();
  });
});
