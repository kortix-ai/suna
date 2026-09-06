import { describe, expect, test } from 'bun:test';
import type { AccountState } from '@kortix/sdk';

import { describePlanStatus } from './account-overview';
import { seatProperties } from './plan-card';

/**
 * The Plan pane's model, tested without React.
 *
 * `describePlanStatus` is the shared answer to "where does this subscription
 * stand" — `PlanSummary` (the account page's balance card) and `PlanCard` (the
 * settings Plan tab) both read it, which is the whole reason it was extracted.
 * Every state below is a real Stripe one that cannot be produced against a
 * local stack without a subscription, so the strings are pinned here.
 */

function stateWith(patch: Partial<AccountState>): AccountState {
  return {
    subscription: { status: 'none', cancel_at_period_end: false, current_period_end: null },
    ...patch,
  } as unknown as AccountState;
}

describe('describePlanStatus', () => {
  test('a live subscription renews on its period end', () => {
    const status = describePlanStatus(
      stateWith({
        subscription: {
          status: 'active',
          cancel_at_period_end: false,
          // 2026-09-24T00:00:00Z, in seconds — the unit `current_period_end` uses.
          current_period_end: 1790208000,
        },
      } as Partial<AccountState>),
    );
    expect(status.detail).toStartWith('Renews ');
    expect(status.isActive).toBe(true);
    expect(status.isWindingDown).toBe(false);
  });

  test('cancel-at-period-end wins over the renewal wording', () => {
    // Same active status, opposite meaning. Reading `status === "active"` and
    // printing "Renews" is the bug this ordering prevents.
    const status = describePlanStatus(
      stateWith({
        subscription: {
          status: 'active',
          cancel_at_period_end: true,
          current_period_end: 1790208000,
        },
      } as Partial<AccountState>),
    );
    expect(status.detail).toStartWith('Cancels ');
    expect(status.isWindingDown).toBe(true);
  });

  test('a raw Stripe status is shown as words, not snake_case', () => {
    const status = describePlanStatus(
      stateWith({
        subscription: { status: 'past_due', cancel_at_period_end: false, current_period_end: null },
      } as Partial<AccountState>),
    );
    expect(status.detail).toBe('past due');
    expect(status.isActive).toBe(false);
  });

  test('no subscription says so rather than rendering an empty line', () => {
    expect(describePlanStatus({} as AccountState).detail).toBe('No subscription');
  });

  test('a per-seat account carries the seat count in the plan name', () => {
    expect(
      describePlanStatus(
        stateWith({ billing_model: 'per_seat', seats: { count: 3 } } as Partial<AccountState>),
      ).name,
    ).toBe('Team · 3 seats');
    // Singular, because "1 seats" is the kind of thing that ships.
    expect(
      describePlanStatus(
        stateWith({ billing_model: 'per_seat', seats: { count: 1 } } as Partial<AccountState>),
      ).name,
    ).toBe('Team · 1 seat');
  });
});

describe('seatProperties', () => {
  test('derives the monthly total from count x price', () => {
    expect(
      seatProperties(
        stateWith({
          billing_model: 'per_seat',
          seats: { count: 3, price_per_seat_usd: 25 },
        } as Partial<AccountState>),
      ),
    ).toEqual([
      { id: 'count', label: 'Seats', value: '3' },
      { id: 'price', label: 'Per seat', value: '$25.00/mo' },
      { id: 'total', label: 'Monthly total', value: '$75.00/mo' },
    ]);
  });

  test('is null for any account that does not bill per seat', () => {
    // The strip is the one thing on the card a flat plan has no version of —
    // rendering three empty columns would be worse than rendering none.
    expect(seatProperties(stateWith({ billing_model: 'legacy' } as Partial<AccountState>))).toBeNull();
    expect(seatProperties(stateWith({}))).toBeNull();
  });

  test('per_seat with no seats block yields null rather than "undefined seats"', () => {
    expect(
      seatProperties(stateWith({ billing_model: 'per_seat' } as Partial<AccountState>)),
    ).toBeNull();
  });
});
