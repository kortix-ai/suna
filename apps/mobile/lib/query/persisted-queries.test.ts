import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { qk } from '@kortix/sdk/react/session-list';

import {
  PERSISTED_QUERY_GC_TIME_MS,
  applyPersistedQueryDefaults,
  isPersistedQueryKey,
  keepFirstSessionPage,
} from './persisted-queries';

/** The drawer's "Sessions" section, one of the SDK's paged session lists. */
const MINE = qk.project.sessionsPaged('p-1', 'visible', { parent: 'root', startedBy: 'me' });

describe('isPersistedQueryKey: what a user navigates by, nothing large or sensitive', () => {
  test.each([
    [['accounts']],
    [['projects', 'acc-1']],
    [['project', 'p-1']],
    // The drawer's sections and the Sessions page's scopes (the SDK's keys).
    [MINE],
    [qk.project.sessionsPaged('p-1', 'visible', { parent: 'root' })],
    [qk.project.sessionsPaged('p-1')],
    // One parent's children, without a search.
    [qk.project.sessionChildren('p-1', 's-1')],
  ])('keeps %j', (key) => {
    expect(isPersistedQueryKey(key)).toBe(true);
  });

  test.each([
    // The flat first page: a lookup copy of the paged list's page one.
    [qk.project.sessions('p-1')],
    // A search: its text is the user's, and its answer is momentary.
    [qk.project.sessionsPaged('p-1', 'visible', { parent: 'root', q: 'deploy' })],
    [qk.project.sessionChildren('p-1', 's-1', 'deploy')],
    // One session's row, from the SDK's persistable set: this app never reads it.
    [qk.project.session('p-1', 's-1')],
    // The keys before the SDK's (stored by an older build).
    [['project-sessions', 'p-1', 'paged']],
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
    [qk.project.sessionsPaged('')],
    [['accounts', 'extra']],
    [[]],
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
    client.setQueryData(MINE, { pages: [], pageParams: [] });
    client.setQueryData(['projects', 'acc-1'], []);
    client.setQueryData(['project', 'p-1'], { project_id: 'p-1' });
    client.setQueryData(['accounts'], []);

    expect(gcTimeOf(client, MINE)).toBe(PERSISTED_QUERY_GC_TIME_MS);
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
  const PAGED = MINE;
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
    client.setQueryData(qk.project.sessions('p-1'), flat, { updatedAt: 1_000 });

    keepFirstSessionPage(client);

    expect(client.getQueryData(PAGED) as unknown).toBe(onePage);
    expect(client.getQueryData(qk.project.sessions('p-1')) as unknown).toBe(flat);
    client.clear();
  });
});
