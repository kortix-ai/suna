import { describe, expect, test } from 'bun:test';

import { addSessionLabel, sameLabels } from './session-labels';

describe('addSessionLabel', () => {
  test('trims, appends, and ignores empty drafts and duplicates', () => {
    expect(addSessionLabel(['bug'], '  customer: eu ')).toEqual({ labels: ['bug', 'customer: eu'] });
    expect(addSessionLabel(['bug'], '   ')).toEqual({ labels: ['bug'] });
    expect(addSessionLabel(['bug'], 'bug')).toEqual({ labels: ['bug'] });
  });

  test('refuses a label over 64 characters and a 21st label', () => {
    expect(addSessionLabel([], 'x'.repeat(65))).toEqual({ problem: 'tooLong' });
    const twenty = Array.from({ length: 20 }, (_, i) => `l${i}`);
    expect(addSessionLabel(twenty, 'one-more')).toEqual({ problem: 'tooMany' });
  });
});

test('sameLabels compares order and content', () => {
  expect(sameLabels(['a', 'b'], ['a', 'b'])).toBe(true);
  expect(sameLabels(['a', 'b'], ['b', 'a'])).toBe(false);
});
