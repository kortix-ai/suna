import { describe, expect, test } from 'bun:test';

import { nextContentRevision } from './use-content-revision';

// Renderers that read their own bytes (xlsx, sqlite) cannot see a cache
// refetch. They remount on this revision, so it must move exactly when the
// content moved: never on the first load, never on an identical refetch.
describe('nextContentRevision', () => {
  const a = { content: 'a' };
  const b = { content: 'b' };

  test('the first load is revision 0, not a change', () => {
    expect(nextContentRevision({ value: undefined, revision: 0 }, a)).toEqual({
      value: a,
      revision: 0,
    });
  });

  test('the same value (structural sharing kept the reference) does not advance', () => {
    const state = { value: a, revision: 3 };
    expect(nextContentRevision(state, a)).toBe(state);
  });

  test('a different value advances by one', () => {
    expect(nextContentRevision({ value: a, revision: 3 }, b)).toEqual({ value: b, revision: 4 });
  });

  test('losing the value (an error between refetches) keeps the last content', () => {
    const state = { value: a, revision: 3 };
    expect(nextContentRevision(state, undefined)).toBe(state);
  });

  test('a → nothing → b still advances, measured against the last real content', () => {
    const gap = nextContentRevision({ value: a, revision: 3 }, undefined);
    expect(nextContentRevision(gap, b)).toEqual({ value: b, revision: 4 });
  });
});
