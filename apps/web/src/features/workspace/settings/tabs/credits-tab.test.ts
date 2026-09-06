import { describe, expect, test } from 'bun:test';
import type { AccountState } from '@kortix/sdk';

import {
  canOfferTopup,
  creditBuckets,
  describeDailyRefresh,
  formatCountdown,
  formatPeriod,
  planGrantMeter,
} from './credits-tab';

/**
 * The Credits pane's model, tested without React.
 *
 * Every function under test is pure and exported for exactly this reason: the
 * shapes that matter — a spent grant, a topped-up grant, a negative balance,
 * an account with no daily refresh — cannot be produced against a local stack
 * without provisioning several accounts and a Stripe subscription. The pane's
 * arithmetic is where a wrong number would come from, so the arithmetic is
 * what is pinned.
 *
 * `$1 = 100 credits` (`CREDITS_PER_DOLLAR`, packages/shared) throughout.
 */

/** A minimal `AccountState` — only the fields these functions read. */
function stateWith(patch: {
  credits?: Partial<AccountState['credits']>;
  tierMonthlyCredits?: number;
}): AccountState {
  return {
    credits: {
      total: 0,
      daily: 0,
      monthly: 0,
      extra: 0,
      can_run: true,
      daily_refresh: null,
      ...patch.credits,
    },
    tier: { monthly_credits: patch.tierMonthlyCredits ?? 0 },
  } as unknown as AccountState;
}

describe('creditBuckets', () => {
  test('splits the balance into the three buckets that sum to it', () => {
    const buckets = creditBuckets(
      stateWith({ credits: { total: 16, monthly: 10, daily: 2, extra: 4 } }),
    );
    expect(buckets.map((b) => [b.id, b.credits])).toEqual([
      ['monthly', 1000],
      ['daily', 200],
      ['extra', 400],
    ]);
    // The strip's arithmetic is visible on screen, so it has to hold: the
    // three columns add up to the headline credit figure above them.
    expect(buckets.reduce((sum, b) => sum + b.credits, 0)).toBe(1600);
  });

  test('always returns three columns, including at zero', () => {
    // A strip whose column count depends on the data reflows between accounts
    // and between refreshes — and "0 purchased" is itself the answer to a
    // question someone opened this pane to ask.
    expect(creditBuckets(stateWith({})).map((b) => b.credits)).toEqual([0, 0, 0]);
  });
});

describe('planGrantMeter', () => {
  test('used = the grant minus what is left of it', () => {
    // $16 grant, $10 of monthly credits left => $6 spent => 600 credits.
    const meter = planGrantMeter(stateWith({ credits: { monthly: 10 }, tierMonthlyCredits: 16 }));
    expect(meter).toEqual({
      usedCredits: 600,
      grantedCredits: 1600,
      percent: 38,
      tone: 'ok',
    });
  });

  test('is null when the plan grants nothing — Free and per-seat Team', () => {
    // A "0 of 0 used" bar is a bar that can never move.
    expect(planGrantMeter(stateWith({ tierMonthlyCredits: 0 }))).toBeNull();
  });

  test('a mid-period top-up cannot print negative usage', () => {
    // `credits.monthly` above the grant is a real state (an admin grant lands
    // in the expiring bucket). Unclamped this reported -400 credits used.
    const meter = planGrantMeter(stateWith({ credits: { monthly: 20 }, tierMonthlyCredits: 16 }));
    expect(meter?.usedCredits).toBe(0);
    expect(meter?.percent).toBe(0);
  });

  test('turns orange at 90% of the grant and red at the cap', () => {
    expect(planGrantMeter(stateWith({ credits: { monthly: 2 }, tierMonthlyCredits: 20 }))?.tone).toBe(
      'low',
    );
    expect(planGrantMeter(stateWith({ credits: { monthly: 0 }, tierMonthlyCredits: 20 }))?.tone).toBe(
      'spent',
    );
    expect(planGrantMeter(stateWith({ credits: { monthly: 10 }, tierMonthlyCredits: 20 }))?.tone).toBe(
      'ok',
    );
  });
});

describe('describeDailyRefresh', () => {
  test('reads the amount and the interval the API computed', () => {
    expect(
      describeDailyRefresh(
        stateWith({
          credits: {
            daily_refresh: {
              enabled: true,
              daily_amount: 4,
              refresh_interval_hours: 24,
              seconds_until_refresh: 15120,
            },
          },
        }),
      ),
    ).toEqual({ amountLine: '+400 credits every 24h', countdown: 'in ~4h 12m' });
  });

  test('is null when the account has no daily refresh, or a zero one', () => {
    expect(describeDailyRefresh(stateWith({}))).toBeNull();
    expect(
      describeDailyRefresh(
        stateWith({
          credits: {
            daily_refresh: { enabled: true, daily_amount: 0, refresh_interval_hours: 24 },
          },
        }),
      ),
    ).toBeNull();
  });
});

describe('formatCountdown', () => {
  test('drops a zero minutes component rather than printing "4h 0m"', () => {
    expect(formatCountdown(14400)).toBe('in ~4h');
  });

  test('omits the hours component under an hour', () => {
    expect(formatCountdown(750)).toBe('in ~12m');
  });

  test('never prints "in ~0m" — a due-or-overdue refresh says so in words', () => {
    // The API clamps `seconds_until_refresh` at 0 and `useAccountState` holds
    // its data for two minutes, so the last minute of the countdown is inside
    // the query's own staleness. It is not a number worth printing.
    expect(formatCountdown(0)).toBe('Any moment now');
    expect(formatCountdown(45)).toBe('Any moment now');
    expect(formatCountdown(null)).toBe('Any moment now');
    expect(formatCountdown(undefined)).toBe('Any moment now');
  });
});

describe('formatPeriod', () => {
  test('renders an en-dashed range with no year', () => {
    expect(formatPeriod('2026-08-24T00:00:00Z', '2026-09-03T00:00:00Z')).toContain('–');
  });

  test('falls back to whichever end is present, and to null when neither is', () => {
    expect(formatPeriod('2026-08-24T00:00:00Z', null)).not.toContain('–');
    expect(formatPeriod(null, null)).toBeNull();
  });

  test('an unparseable date does not render "Invalid Date"', () => {
    expect(formatPeriod('not-a-date', 'also-not')).toBeNull();
  });
});

describe('canOfferTopup', () => {
  /** Only the two fields this gate reads. */
  function purchaseState(
    canPurchaseCredits: boolean,
    canManageBilling?: boolean,
  ): AccountState {
    return {
      subscription: { can_purchase_credits: canPurchaseCredits },
      ...(canManageBilling === undefined ? {} : { can_manage_billing: canManageBilling }),
    } as unknown as AccountState;
  }

  test('needs the tier entitlement AND the billing permission', () => {
    expect(canOfferTopup(purchaseState(true, true))).toBe(true);
    // Entitled plan, wrong person — the card would 403 on click.
    expect(canOfferTopup(purchaseState(true, false))).toBe(false);
    // Right person, plan cannot buy credits at all.
    expect(canOfferTopup(purchaseState(false, true))).toBe(false);
  });

  test('an API response with no `can_manage_billing` does not lock an owner out', () => {
    // The field is additive on the wire and its own API comment says absent
    // means allowed. Reading it as falsy would hide the control on every
    // deployment older than the field.
    expect(canOfferTopup(purchaseState(true))).toBe(true);
  });

  test('an account with no subscription block offers nothing', () => {
    expect(canOfferTopup({} as AccountState)).toBe(false);
  });
});
