import { describe, expect, test } from 'bun:test';
import {
  type AccountStateLike,
  accountHasLiveSubscription,
  billingDialogArgs,
  billingGateCopy,
  billingStateAllowsRun,
  billingStateNeedsTopUp,
  resolveBillingState,
} from './billing-gate-state';

function accountState(overrides: Partial<AccountStateLike> = {}): AccountStateLike {
  return {
    billing_model: 'per_seat',
    credits: { can_run: true, total: 25 },
    subscription: { subscription_id: 'sub_live', status: 'active' },
    tier: { can_purchase_credits: true },
    ...overrides,
  } as AccountStateLike;
}

describe('resolveBillingState — the server state wins', () => {
  test('a server-sent billing_state is used verbatim', () => {
    expect(
      resolveBillingState(
        accountState({ billing_state: 'out_of_credits', credits: { can_run: false, total: 0 } }),
      ),
    ).toBe('out_of_credits');
  });

  test('an unknown billing_state falls back to derivation instead of being trusted', () => {
    expect(
      resolveBillingState(
        accountState({
          billing_state: 'something_new' as never,
          credits: { can_run: true, total: 5 },
        }),
      ),
    ).toBe('active');
  });

  test('unloaded account state is null, never "blocked"', () => {
    expect(resolveBillingState(undefined)).toBeNull();
    expect(billingStateAllowsRun(null)).toBe(true);
  });
});

describe('resolveBillingState — client fallback for an API without billing_state', () => {
  test('Team account on an ACTIVE subscription with a drained wallet is active, never "no plan"', () => {
    const state = resolveBillingState(
      accountState({
        billing_model: 'per_seat',
        credits: { can_run: false, total: 0.0099614711 },
        subscription: { subscription_id: 'sub_live', status: 'active' },
      }),
    );
    expect(state).toBe('active');
    expect(billingStateAllowsRun(state)).toBe(true);
  });

  test('lapsed Team account with a drained wallet is out_of_credits, not no_subscription', () => {
    const state = resolveBillingState(
      accountState({
        billing_model: 'per_seat',
        credits: { can_run: false, total: 0 },
        subscription: { subscription_id: 'sub_gone', status: 'canceled' },
      }),
    );
    expect(state).toBe('out_of_credits');
    expect(billingStateNeedsTopUp(state)).toBe(true);
  });

  test('never-subscribed free account with a drained wallet is no_subscription', () => {
    expect(
      resolveBillingState(
        accountState({
          billing_model: 'legacy',
          credits: { can_run: false, total: 0 },
          subscription: { subscription_id: null, status: null },
          tier: { can_purchase_credits: false },
        }),
      ),
    ).toBe('no_subscription');
  });

  test('a subscription in dunning with an empty wallet is payment_failed', () => {
    expect(
      resolveBillingState(
        accountState({
          billing_model: 'legacy',
          credits: { can_run: false, total: 0 },
          subscription: { subscription_id: 'sub_dunning', status: 'past_due' },
        }),
      ),
    ).toBe('payment_failed');
  });
});

describe('accountHasLiveSubscription', () => {
  test('a canceled subscription id is not a live subscription', () => {
    expect(
      accountHasLiveSubscription(
        accountState({
          has_active_subscription: undefined,
          subscription: { subscription_id: 'sub_gone', status: 'canceled' },
        }),
      ),
    ).toBe(false);
  });

  test('the server flag wins when present', () => {
    expect(
      accountHasLiveSubscription(
        accountState({
          has_active_subscription: true,
          subscription: { subscription_id: null, status: null },
        }),
      ),
    ).toBe(true);
  });
});

describe('billingGateCopy — the gate never contradicts the modal it opens', () => {
  test('out_of_credits pitches a top-up and opens the top-up modal', () => {
    const copy = billingGateCopy('out_of_credits');
    expect(copy.title).toBe('Out of credits');
    expect(copy.ctaLabel).toBe('Top up credits');
    expect(copy.dialogReason).toBe('insufficient_credits');
    expect(copy.message).not.toContain('isn’t on a plan');
  });

  test('no_subscription is the ONLY state that pitches subscribing', () => {
    const copy = billingGateCopy('no_subscription');
    expect(copy.ctaLabel).toBe('Subscribe to Team plan');
    expect(copy.dialogReason).toBe('subscription_required');
  });

  test('payment_failed asks for a payment fix, never claims the plan is unaffected', () => {
    const copy = billingGateCopy('payment_failed');
    expect(copy.ctaLabel).toBe('Fix payment');
    expect(copy.message).not.toContain('unaffected');
  });
});

describe('billingDialogArgs', () => {
  test('a drained subscribed Team account opens the top-up modal, not the subscribe pitch', () => {
    const state = accountState({
      billing_state: 'out_of_credits',
      credits: { can_run: false, total: 0.01 },
      subscription: { subscription_id: 'sub_gone', status: 'canceled' },
    });
    expect(billingDialogArgs('out_of_credits', state, 'acct-1')).toEqual({
      reason: 'insufficient_credits',
      accountId: 'acct-1',
      billingModel: 'per_seat',
      hasSubscription: false,
      billingState: 'out_of_credits',
      balance: 0.01,
    });
  });

  test('a funded account nudged to top up gets the top-up modal, never a subscribe pitch', () => {
    const state = accountState({ billing_state: 'active', credits: { can_run: true, total: 1.2 } });
    expect(billingDialogArgs('active', state, 'acct-3').reason).toBe('insufficient_credits');
  });

  test('a never-subscribed account opens the subscribe pitch', () => {
    const state = accountState({
      billing_state: 'no_subscription',
      billing_model: 'legacy',
      credits: { can_run: false, total: 0 },
      subscription: { subscription_id: null, status: null },
    });
    expect(billingDialogArgs('no_subscription', state, 'acct-2').reason).toBe(
      'subscription_required',
    );
  });
});
