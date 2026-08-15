import { describe, expect, test } from 'bun:test';

import { visibleSuggestions } from './starter-suggestions-logic';

describe('visibleSuggestions', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'];

  test('returns the first `max` items', () => {
    expect(visibleSuggestions(pool, 5)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('a pool smaller than max renders what exists', () => {
    expect(visibleSuggestions(['a', 'b'], 5)).toEqual(['a', 'b']);
  });

  test('an empty pool renders nothing', () => {
    expect(visibleSuggestions([], 5)).toEqual([]);
  });

  test('does not mutate the source pool', () => {
    const source = ['a', 'b', 'c'];
    visibleSuggestions(source, 2);
    expect(source).toEqual(['a', 'b', 'c']);
  });
});
