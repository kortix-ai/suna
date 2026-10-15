import type { AccountState } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { describePlanStatus } from './account-overview';
import { describePlanChange, planPickerView } from './plan-card';

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

  test('Free and Enterprise carry no monthly amount', () => {
    for (const [key, label] of [
      ['free', 'Free'],
      ['enterprise', 'Enterprise'],
    ] as const) {
      const status = describePlanStatus(
        stateWith({
          plan: { key, family: key, label, sublabel: null, monthly_usd: null },
        } as Partial<AccountState>),
      );
      expect(status.name).toBe(label);
      expect(status.sublabel).toBeNull();
    }
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

// One plan system (2026-10-15): an account always sees what it is on and until
// when. Before, an Enterprise account with no Stripe subscription read
// "Enterprise · No subscription".
describe('describePlanStatus for trials and contracts', () => {
  const enterprise = { key: 'enterprise', family: 'enterprise', label: 'Enterprise', sublabel: null, monthly_usd: null };
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const credits = { key: 'credits', family: 'credits', label: 'Credits', sublabel: null, monthly_usd: null };
  const free = { key: 'free', family: 'free', label: 'Free', sublabel: null, monthly_usd: null };

  test('a Credits trial names itself, its days left and its end date', () => {
    const status = describePlanStatus(
      stateWith({
        plan: credits,
        trial: { plan: 'credits', started_at: null, ends_at: '2026-11-14T00:00:00.000Z', days_left: 9 },
      } as Partial<AccountState>),
    );
    expect(status).toMatchObject({ name: 'Credits', sublabel: 'Trial · 9 days left', detail: `Ends ${day('2026-11-14T00:00:00.000Z')}` });
    expect(status.isActive).toBe(true);
    expect(status.isWindingDown).toBe(true);
  });

  test('a trial on its last day says so', () => {
    const status = describePlanStatus(
      stateWith({
        plan: credits,
        trial: { plan: 'credits', started_at: null, ends_at: '2026-11-14T00:00:00.000Z', days_left: 0 },
      } as Partial<AccountState>),
    );
    expect(status.sublabel).toBe('Trial · ends today');
  });

  test('an Enterprise trial leaves the plan card on what the account pays for', () => {
    const status = describePlanStatus(
      stateWith({
        plan: free,
        trial: { plan: 'enterprise', started_at: null, ends_at: '2026-11-14T00:00:00.000Z', days_left: 9 },
      } as Partial<AccountState>),
    );
    expect(status.name).toBe('Free');
    expect(status.sublabel ?? '').not.toContain('Trial');
  });

  test('a renewing contract renews; a contract that does not renew ends', () => {
    const contract = { id: 'c', license_usd: 25000, credits_usd: 15000, term_months: 12, collection: 'invoice', starts_at: null, ends_at: '2027-03-01T00:00:00.000Z', renews: true };
    const renewing = describePlanStatus(stateWith({ plan: enterprise, contract } as Partial<AccountState>));
    expect(renewing).toMatchObject({ sublabel: 'Annual contract', detail: `Renews ${day('2027-03-01T00:00:00.000Z')}`, isActive: true, isWindingDown: false });
    const ending = describePlanStatus(stateWith({ plan: enterprise, contract: { ...contract, renews: false } } as Partial<AccountState>));
    expect(ending.detail).toBe(`Ends ${day('2027-03-01T00:00:00.000Z')}`);
    expect(ending.isWindingDown).toBe(true);
  });

  test('Enterprise without a contract on file never reads "No subscription"', () => {
    const status = describePlanStatus(stateWith({ plan: enterprise } as Partial<AccountState>));
    expect(status.detail).toBe('Annual contract');
    expect(status.detail).not.toBe('No subscription');
  });

  test('after an Enterprise trial, the grace says until when SSO stays on', () => {
    const status = describePlanStatus(
      stateWith({
        plan: { key: 'free', family: 'free', label: 'Free', sublabel: null, monthly_usd: null },
        grace: { reason: 'trial_ended', ends_at: '2026-11-28T00:00:00.000Z' },
      } as Partial<AccountState>),
    );
    expect(status.detail).toBe(`SSO stays on until ${day('2026-11-28T00:00:00.000Z')}`);
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
  const enterprisePlan = { key: 'enterprise', family: 'enterprise', label: 'Enterprise', sublabel: null, status: 'current', shape: 'contract', rank: 3, monthly_usd: null } as AccountState['plan'];
  const trial = { plan: 'enterprise' as const, started_at: null, ends_at: '2026-10-29T00:00:00.000Z', days_left: 14 };

  test('an Enterprise contract is managed with the account team: no picker', () => {
    expect(view({ plan: enterprisePlan }).kind).toBe('enterprise');
  });

  const freePlan = { key: 'free', family: 'free', label: 'Free', sublabel: null, status: 'current', shape: 'none', rank: 1, monthly_usd: null } as AccountState['plan'];
  const creditsPlan = { key: 'credits', family: 'credits', label: 'Credits', sublabel: null, status: 'current', shape: 'credits', rank: 2, monthly_usd: 500 } as AccountState['plan'];

  test('an Enterprise trial on Free gets the picker on the default tier', () => {
    expect(view({ plan: freePlan, trial })).toEqual({ kind: 'picker', currentUsd: null, initialUsd: 200, enterpriseTrial: true });
  });

  test('an Enterprise trial on a paid plan opens on the amount it pays', () => {
    expect(view({ plan: creditsPlan, trial }, { monthly_usd: 500, subscription_id: 'sub_1', status: 'active' })).toEqual({
      kind: 'picker',
      currentUsd: 500,
      initialUsd: 500,
      enterpriseTrial: true,
    });
  });
});
