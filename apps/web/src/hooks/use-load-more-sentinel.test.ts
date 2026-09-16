import { describe, expect, test } from 'bun:test';

import { shouldLoadMore } from './use-load-more-sentinel';

describe('shouldLoadMore', () => {
  test('loads when the sentinel is in range and another page exists', () => {
    expect(shouldLoadMore(true, { hasMore: true, isLoadingMore: false })).toBe(true);
  });

  test('never while a page is already loading, so one scroll issues one request', () => {
    expect(shouldLoadMore(true, { hasMore: true, isLoadingMore: true })).toBe(false);
  });

  test('never after the last page', () => {
    expect(shouldLoadMore(true, { hasMore: false, isLoadingMore: false })).toBe(false);
  });

  test('never while the sentinel is out of range', () => {
    expect(shouldLoadMore(false, { hasMore: true, isLoadingMore: false })).toBe(false);
  });
});
