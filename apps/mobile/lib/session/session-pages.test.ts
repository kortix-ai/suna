import { describe, expect, test } from 'bun:test';
import { InfiniteQueryObserver, QueryClient, onlineManager } from '@tanstack/react-query';

import {
  flattenSessionPages,
  sessionListState,
  sessionsNextCursor,
  shouldLoadMoreSessions,
} from './session-pages';

const row = (session_id: string) => ({ session_id });

describe('session list pages', () => {
  test('next cursor: the page cursor, or undefined at the end (null would page forever)', () => {
    expect(sessionsNextCursor({ items: [], next_cursor: 'abc' })).toBe('abc');
    expect(sessionsNextCursor({ items: [], next_cursor: null })).toBeUndefined();
  });

  test('pages flatten in order; a row that moved between two fetches shows once', () => {
    const pages = [
      { items: [row('a'), row('b')], next_cursor: 'c1' },
      { items: [row('b'), row('c')], next_cursor: null },
    ];
    expect(flattenSessionPages({ pages }).map((s) => s.session_id)).toEqual(['a', 'b', 'c']);
    expect(flattenSessionPages(undefined)).toEqual([]);
  });

  test('load more only when a next page exists and no page fetch is running', () => {
    expect(shouldLoadMoreSessions({ hasNextPage: true, isFetchingNextPage: false, isRefreshing: false })).toBe(true);
    expect(shouldLoadMoreSessions({ hasNextPage: false, isFetchingNextPage: false, isRefreshing: false })).toBe(false);
    expect(shouldLoadMoreSessions({ hasNextPage: true, isFetchingNextPage: true, isRefreshing: false })).toBe(false);
    // A pull to refresh refetches every loaded page; a next page on top would race it.
    expect(shouldLoadMoreSessions({ hasNextPage: true, isFetchingNextPage: false, isRefreshing: true })).toBe(false);
  });
});

describe('sessionListState (COR-146: a failure must never look like an empty list)', () => {
  test('loading wins over everything else — no page loaded yet', () => {
    expect(sessionListState({ isPending: true, isError: false, hasSessions: false })).toBe('loading');
    expect(sessionListState({ isPending: true, isError: true, hasSessions: false })).toBe('loading');
    expect(sessionListState({ isPending: true, isError: false, hasSessions: true })).toBe('loading');
  });

  test('error only when the query failed and nothing survived to show', () => {
    expect(sessionListState({ isPending: false, isError: true, hasSessions: false })).toBe('error');
  });

  test('rows loaded through a failing background poll or refresh stay rows, not error', () => {
    expect(sessionListState({ isPending: false, isError: true, hasSessions: true })).toBe('rows');
  });

  test('empty only once the query succeeded with zero sessions', () => {
    expect(sessionListState({ isPending: false, isError: false, hasSessions: false })).toBe('empty');
  });

  test('rows once at least one session loaded and the query is not erroring', () => {
    expect(sessionListState({ isPending: false, isError: false, hasSessions: true })).toBe('rows');
  });
});

describe('a list that has not loaded is never empty', () => {
  // The flags react-query really reports for the drawer's and the Sessions
  // page's query when the app is offline at its first load.
  test('offline, the first load pauses: loading, not "No sessions yet"', () => {
    onlineManager.setOnline(false);
    const client = new QueryClient();
    try {
      const observer = new InfiniteQueryObserver(client, {
        queryKey: ['project-sessions', 'p-1', 'paged'],
        queryFn: async () => ({ items: [], next_cursor: null }),
        initialPageParam: null as string | null,
        getNextPageParam: sessionsNextCursor,
      });
      const unsubscribe = observer.subscribe(() => {});
      const result = observer.getCurrentResult();

      expect(result.fetchStatus).toBe('paused');
      // `isLoading` reads a paused first load as "not loading": the old input.
      expect(result.isLoading).toBe(false);
      expect(result.isPending).toBe(true);
      expect(
        sessionListState({ isPending: result.isPending, isError: result.isError, hasSessions: false })
      ).toBe('loading');
      unsubscribe();
    } finally {
      client.clear();
      onlineManager.setOnline(true);
    }
  });

  test('once the first page lands with no rows: empty', async () => {
    const client = new QueryClient();
    try {
      const observer = new InfiniteQueryObserver(client, {
        queryKey: ['project-sessions', 'p-2', 'paged'],
        queryFn: async () => ({ items: [], next_cursor: null }),
        initialPageParam: null as string | null,
        getNextPageParam: sessionsNextCursor,
      });
      const unsubscribe = observer.subscribe(() => {});
      await client.getQueryCache().find({ queryKey: ['project-sessions', 'p-2', 'paged'] })?.promise;
      const result = observer.getCurrentResult();

      expect(
        sessionListState({ isPending: result.isPending, isError: result.isError, hasSessions: false })
      ).toBe('empty');
      unsubscribe();
    } finally {
      client.clear();
    }
  });
});

