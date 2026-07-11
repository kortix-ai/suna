import { describe, expect, test } from 'bun:test';
import { executionLeaseUntilOf, hasActiveExecutionLease } from './execution-lease';

describe('execution lease policy', () => {
  const now = new Date('2026-07-11T20:00:00.000Z');
  test('vetoes stop only while the lease is live', () => {
    expect(hasActiveExecutionLease({ executionLeaseUntil: '2026-07-11T20:00:01.000Z' }, now)).toBe(
      true,
    );
    expect(hasActiveExecutionLease({ executionLeaseUntil: '2026-07-11T20:00:00.000Z' }, now)).toBe(
      false,
    );
  });
  test('fails closed on malformed or missing timestamps', () => {
    expect(executionLeaseUntilOf({ executionLeaseUntil: 'bad' })).toBeNull();
    expect(hasActiveExecutionLease(null, now)).toBe(false);
  });
});
