import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import type { ProjectSession } from '@/lib/projects/projects-client';

import {
  applyToSessionCache,
  createdSessionListRow,
  mergeRenamed,
  renameInRows,
  upsertIntoSessionCache,
  withoutSession,
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
