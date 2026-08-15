import { describe, expect, test } from 'bun:test';

import { nextPage, pageCount, sliceForPage } from './starter-suggestions-logic';

const PAGE_SIZE = 3;

describe('pageCount', () => {
  test('a 6-item pool yields 2 pages', () => {
    expect(pageCount(6, PAGE_SIZE)).toBe(2);
  });

  test('a 9-item pool yields 3 pages', () => {
    expect(pageCount(9, PAGE_SIZE)).toBe(3);
  });

  test('a pool smaller than the page size yields 1 page', () => {
    expect(pageCount(2, PAGE_SIZE)).toBe(1);
  });

  test('a pool that does not divide evenly rounds up', () => {
    // 7 items at 3/page: 3 + 3 + 1 — the trailing partial page still counts.
    expect(pageCount(7, PAGE_SIZE)).toBe(3);
  });

  test('an empty pool yields 0 pages', () => {
    expect(pageCount(0, PAGE_SIZE)).toBe(0);
  });
});

describe('sliceForPage', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'];

  test('returns the first pageSize items on page 0', () => {
    expect(sliceForPage(pool, 0, PAGE_SIZE)).toEqual(['a', 'b', 'c']);
  });

  test('returns the next slice on page 1', () => {
    expect(sliceForPage(pool, 1, PAGE_SIZE)).toEqual(['d', 'e', 'f']);
  });

  test('a pool smaller than the page size renders what exists', () => {
    expect(sliceForPage(['a', 'b'], 0, PAGE_SIZE)).toEqual(['a', 'b']);
  });

  test('an out-of-range page returns an empty slice', () => {
    expect(sliceForPage(pool, 5, PAGE_SIZE)).toEqual([]);
  });
});

describe('nextPage', () => {
  test('advances to the next page', () => {
    expect(nextPage(0, 3)).toBe(1);
    expect(nextPage(1, 3)).toBe(2);
  });

  test('wraps around from the last page back to the first', () => {
    expect(nextPage(2, 3)).toBe(0);
  });

  test('is a no-op on a single page', () => {
    expect(nextPage(0, 1)).toBe(0);
  });

  test('is a no-op with zero pages', () => {
    expect(nextPage(0, 0)).toBe(0);
  });
});
