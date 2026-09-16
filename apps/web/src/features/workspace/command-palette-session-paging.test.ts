import { describe, expect, test } from 'bun:test';

import {
  PALETTE_SESSION_RESULT_CAP,
  shouldLoadMorePaletteSessions,
} from '@/features/workspace/command-palette';

const base = {
  open: true,
  hasQuery: true,
  matchCount: 3,
  hasNextPage: true,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
};

describe('shouldLoadMorePaletteSessions', () => {
  test('a search with fewer matches than the result cap loads the next session page', () => {
    // The palette reads paged sessions. A session older than the loaded pages
    // must still be findable by name, as it was when the palette read every session.
    expect(shouldLoadMorePaletteSessions(base)).toBe(true);
  });

  test('stops once the search has a full result list', () => {
    expect(
      shouldLoadMorePaletteSessions({ ...base, matchCount: PALETTE_SESSION_RESULT_CAP }),
    ).toBe(false);
  });

  test('never without a query: browsing shows the most recent sessions only', () => {
    expect(shouldLoadMorePaletteSessions({ ...base, hasQuery: false })).toBe(false);
  });

  test('never while closed, while a page is loading, after the last page, or after a failed page', () => {
    expect(shouldLoadMorePaletteSessions({ ...base, open: false })).toBe(false);
    expect(shouldLoadMorePaletteSessions({ ...base, isFetchingNextPage: true })).toBe(false);
    expect(shouldLoadMorePaletteSessions({ ...base, hasNextPage: false })).toBe(false);
    expect(shouldLoadMorePaletteSessions({ ...base, isFetchNextPageError: true })).toBe(false);
  });
});
