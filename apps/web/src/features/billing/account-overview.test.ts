import type { AccountState } from '@kortix/sdk';
import { formatUsdAsCredits } from '@kortix/shared';
import { describe, expect, test } from 'bun:test';

import { describePlanStatus, formatUsd } from './account-overview';

/**
 * The balance card shows the same quantity twice — credits as the headline,
 * the dollar equivalent (`≈ $868.15`) under it. These pin the dollar line to
 * the two shapes that a hand-rolled `` `$${n}` `` template gets wrong:
 * grouping, and where the minus sign goes.
 */
describe('formatUsd', () => {
  test('formats currency with the selected locale', () => {
    expect(formatUsd(99891.85, 'de-DE')).toBe(
      new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(99891.85),
    );
  });

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

/** The balance and the spend strip read in credits (1 credit = $0.01). */
describe('balance and spend in credits', () => {
  test('the headline balance is whole credits, grouped', () => {
    expect(formatUsdAsCredits(868.15)).toBe('86,815');
    expect(formatUsdAsCredits(166.49)).toBe('16,649');
  });

  test('a negative balance keeps its minus', () => {
    expect(formatUsdAsCredits(-3.2)).toBe('-320');
  });

  test('grouping follows the locale, like the dollar line under it', () => {
    expect(formatUsdAsCredits(868.15, { locale: 'de-DE' })).toBe('86.815');
  });
});

function stateWith(subscription: Record<string, unknown>, monthlyUsd = 500): AccountState {
  return {
    plan: { key: 'credits', family: 'credits', label: 'Credits', sublabel: null, monthly_usd: monthlyUsd },
    subscription: {
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: null,
      scheduled_change: null,
      ...subscription,
    },
  } as unknown as AccountState;
}

describe('describePlanStatus: renewal and a scheduled cut', () => {
  test('a live subscription with a period end says when it renews', () => {
    // 2026-11-14T12:00:00Z, so the day is the same in every US/EU zone.
    const status = describePlanStatus(stateWith({ current_period_end: 1_794_657_600 }));
    expect(status.detail).toBe('Renews Nov 14');
    expect(status.scheduled).toBeNull();
  });

  test('a scheduled cut names the new monthly price in $ and the date it applies', () => {
    const status = describePlanStatus(
      stateWith({
        current_period_end: 1_794_657_600,
        has_scheduled_change: true,
        scheduled_change: {
          type: 'downgrade',
          current_tier: { name: 'credits', display_name: 'Credits', monthly_usd: 5000 },
          target_tier: { name: 'credits', display_name: 'Credits', monthly_usd: 3000 },
          effective_date: '2026-11-14T12:00:00.000Z',
        },
      }),
    );
    expect(status.sublabel).toBe('$500/mo');
    expect(status.scheduled).toBe('→ $3,000/mo from Nov 14');
  });

  test('no line when the scheduled change carries no amount', () => {
    const status = describePlanStatus(
      stateWith({
        scheduled_change: {
          type: 'downgrade',
          current_tier: { name: 'credits', display_name: 'Credits' },
          target_tier: { name: 'free', display_name: 'Free' },
          effective_date: '2026-11-14T12:00:00.000Z',
        },
      }),
    );
    expect(status.scheduled).toBeNull();
  });
});
