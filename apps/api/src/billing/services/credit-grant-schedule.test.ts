import { describe, expect, test } from 'bun:test';
import { calculateNextCreditGrant } from './credit-grant-schedule';

// The next monthly grant anchor, used by the Stripe webhooks, the free-tier
// rotation, and the yearly rotation. It reads the date in local time, the same
// clock the rotations use for their idempotency month.
describe('calculateNextCreditGrant', () => {
  test('returns 1 month from given date', () => {
    const next = calculateNextCreditGrant(new Date('2025-03-15T12:00:00Z'));

    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(3);
    expect(next.getDate()).toBe(15);
  });

  test('handles month boundary (Jan 31 → Feb 28)', () => {
    const next = calculateNextCreditGrant(new Date('2025-01-31T12:00:00Z'));

    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(28);
  });

  test('handles December → January year rollover', () => {
    const next = calculateNextCreditGrant(new Date('2025-12-15T12:00:00Z'));

    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(15);
  });
});
