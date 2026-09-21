import { describe, expect, test } from 'bun:test';

import { flattenSessionPages, sessionsNextCursor, shouldLoadMoreSessions } from './session-pages';

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
