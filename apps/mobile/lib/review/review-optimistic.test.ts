import { describe, expect, test } from 'bun:test';
import type { ReviewItemStatus } from '@kortix/sdk';

import { applyReviewStatuses, verdictResultStatus } from './review-optimistic';

describe('verdictResultStatus', () => {
  test('each verdict lands the item in a Done status', () => {
    expect(verdictResultStatus('approve')).toBe('approved');
    expect(verdictResultStatus('reject')).toBe('rejected');
    expect(verdictResultStatus('changes')).toBe('changes_requested');
    expect(verdictResultStatus('dismiss')).toBe('dismissed');
    expect(verdictResultStatus('answer')).toBe('done');
  });
});

describe('applyReviewStatuses', () => {
  const items: { id: string; status: ReviewItemStatus; title: string }[] = [
    { id: 'cr:1', status: 'needs_you', title: 'a' },
    { id: 'cr:2', status: 'needs_you', title: 'b' },
  ];

  test('overrides only the named items, keeps the rest by reference', () => {
    const out = applyReviewStatuses(items, { 'cr:1': 'approved' });
    expect(out[0]).toEqual({ id: 'cr:1', status: 'approved', title: 'a' });
    expect(out[1]).toBe(items[1]);
  });

  test('no overrides returns the same array', () => {
    expect(applyReviewStatuses(items, {})).toBe(items);
  });
});
