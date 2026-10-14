import type { AccountState } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  creditBuckets,
  formatPeriod,
  planGrantMeter,
} from './credits-tab';

/**
 * The Credits pane's model, tested without React.
 *
 * Every function under test is pure and exported for exactly this reason: the
 * shapes that matter — a spent grant, a topped-up grant, a negative balance,
 * a zero balance — cannot be produced against a local stack
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
      monthly: 0,
      extra: 0,
      can_run: true,
      ...patch.credits,
    },
    tier: { monthly_credits: patch.tierMonthlyCredits ?? 0 },
  } as unknown as AccountState;
}

describe('creditBuckets', () => {
  test('uses the supplied locale copy for every bucket', () => {
    expect(
      creditBuckets(stateWith({}), {
        monthly: { label: 'Кредити плана', hint: 'Истичу на крају периода' },
        extra: { label: 'Купљени', hint: 'Никада не истичу' },
      }).map(({ label, hint }) => [label, hint]),
    ).toEqual([
      ['Кредити плана', 'Истичу на крају периода'],
      ['Купљени', 'Никада не истичу'],
    ]);
  });

  test('splits the balance into the two buckets that sum to it', () => {
    const buckets = creditBuckets(
      stateWith({ credits: { total: 16, monthly: 10, extra: 4 } }),
    );
    expect(buckets.map((b) => [b.id, b.credits])).toEqual([
      ['monthly', 1000],
      ['extra', 400],
    ]);
    // The strip's arithmetic is visible on screen, so it has to hold: the
    // two columns add up to the headline credit figure above them.
    expect(buckets.reduce((sum, b) => sum + b.credits, 0)).toBe(1400);
  });

  test('always returns two columns, including at zero', () => {
    // A strip whose column count depends on the data reflows between accounts
    // and between refreshes — and "0 purchased" is itself the answer to a
    // question someone opened this pane to ask.
    expect(creditBuckets(stateWith({})).map((b) => b.credits)).toEqual([0, 0]);
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

  test('is null when the plan grants nothing', () => {
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
    expect(
      planGrantMeter(stateWith({ credits: { monthly: 2 }, tierMonthlyCredits: 20 }))?.tone,
    ).toBe('low');
    expect(
      planGrantMeter(stateWith({ credits: { monthly: 0 }, tierMonthlyCredits: 20 }))?.tone,
    ).toBe('spent');
    expect(
      planGrantMeter(stateWith({ credits: { monthly: 10 }, tierMonthlyCredits: 20 }))?.tone,
    ).toBe('ok');
  });
});

describe('formatPeriod', () => {
  test('formats dates with the selected locale', () => {
    expect(formatPeriod('2026-08-24T00:00:00Z', '2026-09-03T00:00:00Z', 'sr')).toBe(
      '24. авг – 3. сеп',
    );
  });

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
