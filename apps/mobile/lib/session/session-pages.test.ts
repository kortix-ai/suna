import { describe, expect, test } from 'bun:test';

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
  test('loading wins over everything else — the first fetch, no rows yet', () => {
    expect(sessionListState({ isLoading: true, isError: false, hasSessions: false })).toBe('loading');
    expect(sessionListState({ isLoading: true, isError: true, hasSessions: false })).toBe('loading');
    expect(sessionListState({ isLoading: true, isError: false, hasSessions: true })).toBe('loading');
  });

  test('error only when the query failed and nothing survived to show', () => {
    expect(sessionListState({ isLoading: false, isError: true, hasSessions: false })).toBe('error');
  });

  test('rows loaded through a failing background poll or refresh stay rows, not error', () => {
    expect(sessionListState({ isLoading: false, isError: true, hasSessions: true })).toBe('rows');
  });

  test('empty only once the query succeeded with zero sessions', () => {
    expect(sessionListState({ isLoading: false, isError: false, hasSessions: false })).toBe('empty');
  });

  test('rows once at least one session loaded and the query is not erroring', () => {
    expect(sessionListState({ isLoading: false, isError: false, hasSessions: true })).toBe('rows');
  });
});
