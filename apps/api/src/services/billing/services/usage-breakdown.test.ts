import { describe, expect, test } from 'bun:test';

import { classifyLedgerKind, currentPeriodStart } from './usage-breakdown';

// The SQL half of the breakdown (kind resolution from metadata, the debit
// filter, the sign guard, the period bound) runs on PostgreSQL in
// tests/migration/usage-breakdown-ledger-type.test.ts.

/**
 * "Spend this period" was anchored on Stripe's FIXED subscription anchor, which
 * never moves — so the window never reset and the figure quietly accumulated
 * LIFETIME spend under a this-period label. Production Kortix account: anchor
 * 2026-06-07, still being used two months later.
 */
describe('currentPeriodStart', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');

  test('rolls a stale anchor forward to the current period', () => {
    // The exact production case: anchor 2026-06-07, read on 2026-08-05. The
    // period running on that date began 2026-07-07 — the 8th of August has not
    // happened yet. Before this, the window start was reported as the June
    // anchor, so "this period" covered two months and counting.
    expect(currentPeriodStart('2026-06-07T03:20:08.000Z', now)).toBe('2026-07-07T03:20:08.000Z');
  });

  test('mid-February, a 31st anchor is still in its January period', () => {
    // The period beginning Jan 31 runs until the February occurrence, so on
    // Feb 15 the answer is still January.
    expect(currentPeriodStart('2026-01-31T00:00:00.000Z', new Date('2026-02-15T00:00:00.000Z'))).toBe(
      '2026-01-31T00:00:00.000Z',
    );
  });

  test('clamps a 31st anchor to the last day of a shorter month', () => {
    // Stripe's own rule, and the case that actually exercises the clamp:
    // without it, Date rolls Feb 31 over into March 3.
    expect(currentPeriodStart('2026-01-31T00:00:00.000Z', new Date('2026-03-01T00:00:00.000Z'))).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  test('an anchor in the future is left alone', () => {
    expect(currentPeriodStart('2027-01-01T00:00:00.000Z', now)).toBe('2027-01-01T00:00:00.000Z');
  });

  test('a null or unparseable anchor yields null, never a wrong window', () => {
    expect(currentPeriodStart(null, now)).toBeNull();
    expect(currentPeriodStart('not-a-date', now)).toBeNull();
  });
});

/**
 * `usage` is what the router writes for a Kortix tool call. It was in neither
 * kind list, and the query filters on those lists — so the money was not merely
 * uncategorised, it was excluded from the result set and vanished from the
 * total. 10,859 such rows on the production Kortix account.
 *
 * CHANGED DELIBERATELY. `usage` used to classify as null, on the reasoning that
 * it is the flat RPC type and therefore not a real category. True, but
 * returning null did not leave the money uncategorised — it excluded the row
 * and the spend vanished from the total. Money that left the wallet has to
 * appear somewhere; "other" is honest, silence is not.
 *
 * A refund is a CREDIT. Counting it as spend would overstate the bill, and the
 * sign guard in the query is the second line of defence.
 */
describe('classifyLedgerKind covers every kind that is actually written', () => {
  test.each([
    ['compute_debit', 'compute'],
    ['llm_debit', 'llm'],
    ['token_deduction', 'llm'],
    ['token_overage', 'llm'],
    ['usage', 'other'],
    ['admin_debit', 'other'],
    ['tool_reservation_refund', null],
    [null, null],
  ] as const)('%p -> %p', (kind, expected) => {
    expect(classifyLedgerKind(kind)).toBe(expected);
  });
});
