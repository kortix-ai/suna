import type { AccountState } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { describePlanStatus } from './account-overview';
import { describePlanChange, planPickerView, scheduledDowngrade } from './plan-card';

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
  test('uses localized status and monthly-amount copy', () => {
    const state = stateWith({
      plan: { key: 'credits', family: 'credits', label: 'Кредити', sublabel: null, monthly_usd: 100 },
      subscription: {
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: 1790208000,
      },
    } as Partial<AccountState>);
    expect(
      describePlanStatus(state, {
        locale: 'sr',
        perMonth: (amount) => `${amount}/мес`,
        cancels: (date) => `Отказује се ${date}`,
        cancelsAtPeriodEnd: 'Отказује се на крају периода',
        renews: (date) => `Обнавља се ${date}`,
        active: 'Активна',
        noSubscription: 'Нема претплате',
        status: (value) => value,
      }),
    ).toMatchObject({ name: 'Кредити', detail: 'Обнавља се 24. сеп' });
    const { sublabel } = describePlanStatus(state, {
      locale: 'sr',
      perMonth: (amount) => `${amount}/мес`,
      cancels: String,
      cancelsAtPeriodEnd: '',
      renews: String,
      active: '',
      noSubscription: '',
      status: String,
    });
    expect(sublabel).toStartWith('100');
    expect(sublabel).toEndWith('/мес');
  });

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

  test('a credits plan names itself and its monthly amount', () => {
    const status = describePlanStatus(
      stateWith({
        plan: { key: 'credits', family: 'credits', label: 'Credits', sublabel: null, monthly_usd: 100 },
      } as Partial<AccountState>),
    );
    expect(status.name).toBe('Credits');
    expect(status.sublabel).toBe('$100/mo');
  });

  test('Free carries no monthly amount', () => {
    const status = describePlanStatus(
      stateWith({
        plan: { key: 'free', family: 'free', label: 'Free', sublabel: null, monthly_usd: null },
      } as Partial<AccountState>),
    );
    expect(status.name).toBe('Free');
    expect(status.sublabel).toBeNull();
  });
});

describe('describePlanChange', () => {
  test('no paid subscription starts checkout for any valid amount', () => {
    expect(describePlanChange({ currentUsd: null, nextUsd: 100, hasSubscription: false })).toBe(
      'subscribe',
    );
  });

  test('a higher amount is a raise, a lower one a cut, the same one unchanged', () => {
    expect(describePlanChange({ currentUsd: 100, nextUsd: 500, hasSubscription: true })).toBe(
      'raise',
    );
    expect(describePlanChange({ currentUsd: 100, nextUsd: 50, hasSubscription: true })).toBe('cut');
    expect(describePlanChange({ currentUsd: 100, nextUsd: 100, hasSubscription: true })).toBe(
      'unchanged',
    );
  });

  test('an amount off the tier ladder is invalid, with or without a subscription', () => {
    for (const nextUsd of [null, 20, 49, 250, 10_001, 75.5]) {
      expect(describePlanChange({ currentUsd: 100, nextUsd, hasSubscription: true })).toBe(
        'invalid',
      );
      expect(describePlanChange({ currentUsd: null, nextUsd, hasSubscription: false })).toBe(
        'invalid',
      );
    }
  });

  test('a live subscription with no known amount counts as a raise, not a new checkout', () => {
    expect(describePlanChange({ currentUsd: null, nextUsd: 100, hasSubscription: true })).toBe(
      'raise',
    );
  });
});

// Trials are removed and Enterprise is a feature layer, not a plan
// (2026-10-15): the plan card describes the billing plan only.
describe('describePlanStatus without trials', () => {
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const free = { key: 'free', family: 'free', label: 'Free', sublabel: null, monthly_usd: null };

  test('a leftover trial block changes nothing: the card names the billing plan', () => {
    const status = describePlanStatus(
      stateWith({
        plan: free,
        trial: { plan: 'credits', started_at: null, ends_at: '2026-11-14T00:00:00.000Z', days_left: 9 },
      } as Partial<AccountState>),
    );
    expect(status).toMatchObject({ name: 'Free', sublabel: null, isWindingDown: false });
    expect(status.detail.toLowerCase()).not.toContain('trial');
  });

  test('after a license ends, the grace says until when SSO stays on', () => {
    const status = describePlanStatus(
      stateWith({ plan: free, grace: { reason: 'contract_ended', ends_at: '2026-11-28T00:00:00.000Z' } } as Partial<AccountState>),
    );
    expect(status.detail).toBe(`SSO stays on until ${day('2026-11-28T00:00:00.000Z')}`);
  });
});

describe('describePlanChange with a downgrade scheduled', () => {
  // In effect this period: $500. Scheduled from the renewal: $100.
  const base = { currentUsd: 500, scheduledUsd: 100, hasSubscription: true };

  test('the amount in effect again keeps the plan (cancels the downgrade)', () => {
    expect(describePlanChange({ ...base, nextUsd: 500 })).toBe('keep');
  });

  test('the scheduled amount itself changes nothing', () => {
    expect(describePlanChange({ ...base, nextUsd: 100 })).toBe('unchanged');
  });

  test('another lower amount is still a cut; a higher one a raise from the amount in effect', () => {
    expect(describePlanChange({ ...base, nextUsd: 200 })).toBe('cut');
    expect(describePlanChange({ ...base, nextUsd: 1000 })).toBe('raise');
  });
});

describe('scheduledDowngrade', () => {
  test('reads the target amount and date from subscription.scheduled_change', () => {
    const state = stateWith({
      subscription: {
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: 1794700800,
        scheduled_change: {
          type: 'downgrade',
          current_tier: { name: 'credits', display_name: 'Credits', monthly_credits: 50_000, monthly_usd: 500 },
          target_tier: { name: 'credits', display_name: 'Credits', monthly_credits: 10_000, monthly_usd: 100 },
          effective_date: '2026-11-14T00:00:00.000Z',
        },
      },
    } as unknown as Partial<AccountState>);
    expect(scheduledDowngrade(state)).toEqual({ monthlyUsd: 100, effectiveAt: '2026-11-14T00:00:00.000Z' });
  });

  test('null without a scheduled change, or for a non-credits change', () => {
    expect(scheduledDowngrade(stateWith({}))).toBeNull();
  });
});

describe('planPickerView', () => {
  const view = (over: Partial<AccountState>, subscription: Record<string, unknown> = {}) =>
    planPickerView(
      stateWith({
        ...over,
        subscription: { status: 'none', cancel_at_period_end: false, current_period_end: null, ...subscription },
      } as Partial<AccountState>),
    );
  const freePlan = { key: 'free', family: 'free', label: 'Free', sublabel: null, status: 'current', shape: 'none', rank: 1, monthly_usd: null } as AccountState['plan'];
  const creditsPlan = { key: 'credits', family: 'credits', label: 'Credits', sublabel: null, status: 'current', shape: 'credits', rank: 2, monthly_usd: 500 } as AccountState['plan'];

  test('a Free account opens on the default tier', () => {
    expect(view({ plan: freePlan })).toEqual({ currentUsd: null, initialUsd: 200 });
  });

  test('a paying account opens on the amount it pays', () => {
    expect(view({ plan: creditsPlan }, { monthly_usd: 500, subscription_id: 'sub_1', status: 'active' })).toEqual({
      currentUsd: 500,
      initialUsd: 500,
    });
  });

  test('the subscription amount is the fallback when the plan block has none', () => {
    expect(view({ plan: { ...creditsPlan!, monthly_usd: null } }, { monthly_usd: 100, subscription_id: 'sub_1', status: 'active' })).toEqual({
      currentUsd: 100,
      initialUsd: 100,
    });
  });

  test('Enterprise demo or license still gets the picker: Enterprise never replaces the plan', () => {
    const demo = view({ plan: freePlan, enterprise: { state: 'demo' } });
    const licensed = view({ plan: creditsPlan, enterprise: { state: 'licensed' } }, { monthly_usd: 500, subscription_id: 'sub_1', status: 'active' });
    expect(demo).toEqual({ currentUsd: null, initialUsd: 200 });
    expect(licensed).toEqual({ currentUsd: 500, initialUsd: 500 });
  });

  test('a live subscription on an unreported amount opens on "choose a tier"', () => {
    expect(view({ plan: { ...creditsPlan!, monthly_usd: null } }, { subscription_id: 'sub_1', status: 'active' })).toEqual({
      currentUsd: null,
      initialUsd: null,
    });
  });
});
