import { describe, expect, test } from 'bun:test';

import { formatUsd } from './account-overview';

/**
 * The balance card shows the same quantity twice — dollars on top, credits
 * under it — and `formatCredits` has always grouped its thousands. These pin
 * the dollar side to the same convention, and pin the two shapes that a
 * hand-rolled `` `$${n}` `` template gets wrong: grouping, and where the minus
 * sign goes.
 */
describe('formatUsd', () => {
  test('groups thousands — a five-figure balance is read, not counted', () => {
    expect(formatUsd(99891.85)).toBe('$99,891.85');
  });

  test('always two decimals, even on a round number', () => {
    expect(formatUsd(60)).toBe('$60.00');
  });

  test('the minus goes outside the dollar sign, not between it and the digits', () => {
    expect(formatUsd(-3.2)).toBe('-$3.20');
  });

  test('sub-cent amounts round to cents rather than spilling digits', () => {
    expect(formatUsd(0.004)).toBe('$0.00');
    expect(formatUsd(1.005)).toBe('$1.01');
  });

  test('missing or non-finite values render as zero, never NaN', () => {
    expect(formatUsd(undefined)).toBe('$0.00');
    expect(formatUsd(null)).toBe('$0.00');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });
});
