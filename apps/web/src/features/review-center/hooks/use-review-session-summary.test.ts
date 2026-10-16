import { describe, expect, test } from 'bun:test';

import { withNeedsInput } from './use-review-session-summary';

// KRTX-1739: a session whose agent waits on a question reads `needs-you` too.
describe('withNeedsInput', () => {
  test('adds a session that only GET needs-input lists (an open agent question)', () => {
    expect(withNeedsInput({ s1: 2 }, { total: 1, sessions: { s2: 1 } })).toEqual({ s1: 2, s2: 1 });
  });

  test('takes the larger count: a connector approval is in both lists, a sum would count it twice', () => {
    expect(withNeedsInput({ s1: 1, s2: 3 }, { total: 3, sessions: { s1: 2, s2: 1 } })).toEqual({ s1: 2, s2: 3 });
  });

  test('no needs-input summary yet, or an empty one, keeps the review counts as they are', () => {
    const reviews = { s1: 1 };
    expect(withNeedsInput(reviews, undefined)).toBe(reviews);
    expect(withNeedsInput(reviews, { total: 0, sessions: {} })).toBe(reviews);
  });
});
