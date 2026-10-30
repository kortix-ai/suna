import { describe, expect, test } from 'bun:test';

import { shouldEmit } from './use-debounced-value';

describe('shouldEmit', () => {
  test('emits immediately when the value clears', () => {
    // An empty query must not wait 150ms — closing the menu should be instant.
    expect(shouldEmit('', 'abc')).toBe(true);
  });

  test('debounces a non-empty change', () => {
    expect(shouldEmit('ab', 'a')).toBe(false);
  });

  test('does not emit when the value is unchanged', () => {
    expect(shouldEmit('ab', 'ab')).toBe(false);
  });
});
