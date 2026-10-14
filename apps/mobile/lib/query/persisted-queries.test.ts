import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import type { KeyValueStorage } from '@kortix/sdk';

import {
  PERSISTED_QUERY_GC_TIME_MS,
  QUERY_CACHE_OPTIONS,
  applyPersistedQueryDefaults,
  isPersistedQueryKey,
  keepFirstSessionPage,
} from './persisted-queries';
import { createQueryCacheBinder } from './query-cache-binder';

// The keys below come from the app's own `projectKeys` (lib/projects/hooks.ts).
// Its React Native imports cannot load under `bun test`: every module it
// imports is replaced, except the ones its key builders run on.
const PROJECTS_DIR = join(import.meta.dir, '../projects');
const hooksSource = readFileSync(join(PROJECTS_DIR, 'hooks.ts'), 'utf8');
const realModules = new Set([
  'react',
  '@tanstack/react-query',
  '@kortix/sdk',
  '@kortix/sdk/react',
  '@/lib/session/session-pages',
  '@/lib/session/session-cache-write',
  '@/lib/session/session-tree',
  './poll-policy',
]);
for (const [, names, name] of hooksSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (realModules.has(name)) continue;
  const values: Record<string, unknown> = {};
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key) values[key] = () => null;
  }
  mock.module(name.startsWith('./') ? join(PROJECTS_DIR, name) : name, () => values);
}
const { projectKeys } = await import('@/lib/projects/hooks');

/** The drawer's three sections (components/session/ProjectLeftDrawer.tsx). */
const DRAWER_MINE = projectKeys.projectSessionsPaged('p-1', { parent: 'root', startedBy: 'me' });
const DRAWER_SHARED = projectKeys.projectSessionsPaged('p-1', { parent: 'root', startedBy: 'others' });
const DRAWER_AUTOMATED = projectKeys.projectSessionsPaged('p-1', {
  parent: 'root',
  startedBy: 'automated',
});
/** The Sessions page's "All" scope (components/session/ProjectSessionsPage.tsx). */
const SESSIONS_PAGE_ALL = projectKeys.projectSessionsPaged('p-1', { parent: 'root' });
/** A search: the user's text, never stored. */
const SEARCH = projectKeys.projectSessionsPaged('p-1', { parent: 'root', q: 'x' });

describe('isPersistedQueryKey: what a user navigates by, nothing large or sensitive', () => {
  test.each([
    [['accounts']],
    [['projects', 'acc-1']],
    [['project', 'p-1']],
    [['project-sessions', 'p-1', 'paged']],
  ])('keeps %j', (key) => {
    expect(isPersistedQueryKey(key)).toBe(true);
  });

  test.each([
    // The flat first page: a lookup copy of the paged list's page one.
    [['project-sessions', 'p-1']],
    // The config summary carries the repository's whole file listing.
    [['project-detail', 'p-1']],
    [['project-secrets', 'p-1']],
    [['project-files', 'p-1', 'main']],
    [['project-file-content', 'p-1', 'README.md', 'main']],
    [['session-public-shares', 'p-1', 's-1']],
    [['project-model-picker', 'p-1']],
    [['account-state']],
    // A disabled query's key: no id yet.
    [['projects', null]],
    [['project', undefined]],
    [['project', '']],
    [['project-sessions', null, 'paged']],
    [['accounts', 'extra']],
    [[]],
  ])('does not keep %j', (key) => {
    expect(isPersistedQueryKey(key)).toBe(false);
  });

  // Since #8258 the drawer and the Sessions page read filtered keys. A restart
  // showed a loader until the network answered: none of them was kept.
  test.each([
    ['the drawer’s Sessions', DRAWER_MINE],
    ['the drawer’s Shared', DRAWER_SHARED],
    ['the drawer’s Automated', DRAWER_AUTOMATED],
    ['the Sessions page’s All', SESSIONS_PAGE_ALL],
  ])('keeps %s list', (_name, key) => {
    expect(key).toHaveLength(4);
    expect(isPersistedQueryKey(key)).toBe(true);
  });

  test('never keeps a search: its text is the user’s', () => {
    expect(SEARCH).toHaveLength(4);
    expect(isPersistedQueryKey(SEARCH)).toBe(false);
  });

  test.each([
    [['project-sessions', 'p-1', 'paged', null]],
    [['project-sessions', 'p-1', 'paged', 'root']],
    [['project-sessions', 'p-1', 'paged', { parent: 'root' }, 'extra']],
    [['project-sessions', null, 'paged', { parent: 'root' }]],
    // One parent's children and one session's row, under the same family.
    [projectKeys.sessionChildren('p-1', 's-1')],
    [projectKeys.projectSession('p-1', 's-1')],
  ])('does not keep %j', (key) => {
    expect(isPersistedQueryKey(key)).toBe(false);
  });
});

describe('applyPersistedQueryDefaults', () => {
  // React Native's default. Under `bun test` (no `window`) TanStack defaults
  // to Infinity, the server value, so the test states the device's.
  const DEVICE_GC_TIME_MS = 5 * 60 * 1000;
  const deviceClient = () =>
    new QueryClient({ defaultOptions: { queries: { gcTime: DEVICE_GC_TIME_MS } } });
  const gcTimeOf = (client: QueryClient, queryKey: readonly unknown[]) =>
    client.getQueryCache().find({ queryKey, exact: true })?.gcTime;

  test('a restored entry of a kept family outlives the 5-minute default until its screen mounts', () => {
    const client = deviceClient();
    applyPersistedQueryDefaults(client);
    // `setQueryData` is how the persisted cache restores an entry.
    client.setQueryData(['project-sessions', 'p-1', 'paged'], { pages: [], pageParams: [] });
    client.setQueryData(['projects', 'acc-1'], []);
    client.setQueryData(['project', 'p-1'], { project_id: 'p-1' });
    client.setQueryData(['accounts'], []);

    expect(gcTimeOf(client, ['project-sessions', 'p-1', 'paged'])).toBe(PERSISTED_QUERY_GC_TIME_MS);
    expect(gcTimeOf(client, ['projects', 'acc-1'])).toBe(PERSISTED_QUERY_GC_TIME_MS);
    expect(gcTimeOf(client, ['project', 'p-1'])).toBe(PERSISTED_QUERY_GC_TIME_MS);
    expect(gcTimeOf(client, ['accounts'])).toBe(PERSISTED_QUERY_GC_TIME_MS);
    client.clear();
  });

  test('other families keep the default gc time', () => {
    const client = deviceClient();
    applyPersistedQueryDefaults(client);
    client.setQueryData(['project-detail', 'p-1'], { files: [] });
    client.setQueryData(['project-secrets', 'p-1'], []);

    expect(gcTimeOf(client, ['project-detail', 'p-1'])).toBe(DEVICE_GC_TIME_MS);
    expect(gcTimeOf(client, ['project-secrets', 'p-1'])).toBe(DEVICE_GC_TIME_MS);
    client.clear();
  });
});

describe('keepFirstSessionPage: a restored list refetches one page, not every page', () => {
  const PAGED = ['project-sessions', 'p-1', 'paged'] as const;
  const page = (id: string, next: string | null) => ({
    items: [{ session_id: id }],
    next_cursor: next,
  });

  test('a restored paged list keeps page one, at its original age', () => {
    const client = new QueryClient();
    client.setQueryData(
      PAGED,
      {
        pages: [page('a', 'c1'), page('b', 'c2'), page('c', null)],
        pageParams: [null, 'c1', 'c2'],
      },
      { updatedAt: 1_000 }
    );

    keepFirstSessionPage(client);

    expect(client.getQueryData(PAGED) as unknown).toEqual({
      pages: [page('a', 'c1')],
      pageParams: [null],
    });
    // Still stale: its screen refetches it on mount.
    expect(client.getQueryState(PAGED)?.dataUpdatedAt).toBe(1_000);
    client.clear();
  });

  test('a one-page list and every other query are left as they are', () => {
    const client = new QueryClient();
    const onePage = { pages: [page('a', null)], pageParams: [null] };
    const flat = [{ session_id: 'a' }, { session_id: 'b' }];
    client.setQueryData(PAGED, onePage, { updatedAt: 1_000 });
    client.setQueryData(['project-sessions', 'p-1'], flat, { updatedAt: 1_000 });

    keepFirstSessionPage(client);

    expect(client.getQueryData(PAGED) as unknown).toBe(onePage);
    expect(client.getQueryData(['project-sessions', 'p-1']) as unknown).toBe(flat);
    client.clear();
  });

  test('the drawer’s and the Sessions page’s filtered lists keep page one too', () => {
    const client = new QueryClient();
    const threePages = {
      pages: [page('a', 'c1'), page('b', 'c2'), page('c', null)],
      pageParams: [null, 'c1', 'c2'],
    };
    for (const key of [DRAWER_MINE, DRAWER_SHARED, SESSIONS_PAGE_ALL]) {
      client.setQueryData(key, threePages, { updatedAt: 1_000 });
    }

    keepFirstSessionPage(client);

    for (const key of [DRAWER_MINE, DRAWER_SHARED, SESSIONS_PAGE_ALL]) {
      expect(client.getQueryData(key) as unknown).toEqual({ pages: [page('a', 'c1')], pageParams: [null] });
      expect(client.getQueryState(key)?.dataUpdatedAt).toBe(1_000);
    }
    client.clear();
  });
});

describe('an app restart renders the drawer from the stored lists', () => {
  const T0 = Date.parse('2026-10-14T12:00:00Z');
  const twoPages = (prefix: string) => ({
    pages: [
      { items: [{ session_id: `${prefix}-1` }], next_cursor: 'c1' },
      { items: [{ session_id: `${prefix}-2` }], next_cursor: null },
    ],
    pageParams: [null, 'c1'],
  });

  function memoryStorage(): KeyValueStorage {
    const data = new Map<string, string>();
    return {
      getItem: async (key) => data.get(key) ?? null,
      setItem: async (key, value) => {
        data.set(key, value);
      },
      removeItem: async (key) => {
        data.delete(key);
      },
    };
  }

  /** The app's binder (lib/query/query-cache.ts), over a test store. */
  const appBinder = (storage: KeyValueStorage) =>
    createQueryCacheBinder({ ...QUERY_CACHE_OPTIONS, storage, throttleMs: 0, now: () => T0 });

  test('a persisted, then restored, client holds each drawer section’s first page and no later page', async () => {
    const storage = memoryStorage();
    // The previous run: the drawer walked two pages of each section, and a search.
    const previous = appBinder(storage);
    const before = new QueryClient();
    applyPersistedQueryDefaults(before);
    await previous.bind(before, 'user-a');
    for (const [key, prefix] of [
      [DRAWER_MINE, 'mine'],
      [DRAWER_SHARED, 'shared'],
      [DRAWER_AUTOMATED, 'automated'],
      [SEARCH, 'search'],
    ] as const) {
      before.setQueryData(key, twoPages(prefix), { updatedAt: T0 - 60_000 });
    }
    await previous.flush();

    // The restart: a new client, restored before the first frame.
    const after = new QueryClient();
    applyPersistedQueryDefaults(after);
    await appBinder(storage).bind(after, 'user-a');

    for (const [key, prefix] of [
      [DRAWER_MINE, 'mine'],
      [DRAWER_SHARED, 'shared'],
      [DRAWER_AUTOMATED, 'automated'],
    ] as const) {
      expect(after.getQueryData(key) as unknown).toEqual({
        pages: [twoPages(prefix).pages[0]],
        pageParams: [null],
      });
      // At its original age: the drawer refetches it on mount.
      expect(after.getQueryState(key)?.dataUpdatedAt).toBe(T0 - 60_000);
    }
    expect(after.getQueryData(SEARCH)).toBeUndefined();
    before.clear();
    after.clear();
  });
});
