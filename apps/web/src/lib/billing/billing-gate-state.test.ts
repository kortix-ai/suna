import { describe, expect, test } from 'bun:test';
import {
  type AccountStateLike,
  accountHasLiveSubscription,
  billingDialogArgs,
  billingGateCopy,
  billingModalCopy,
  billingStateAllowsRun,
  billingStateNeedsTopUp,
  resolveBillingState,
  walletSeverity,
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
  test('Team account on an ACTIVE subscription with a drained wallet is blocked, never "no plan"', () => {
    // The fallback used to return `active` here — its own copy of the removed
    // `subscriptionBypassesWalletFloor`. On a rolling deploy that is the worst
    // possible answer: an old API sends no `billing_state`, this fallback runs,
    // and the UI renders a drained Team account as runnable while the new API
    // beside it is already 402ing every prompt.
    //
    // Note `can_run: false` — the server had ALREADY said no. The fallback's job
    // is to agree with it and explain it, never to overrule it.
    const state = resolveBillingState(
      accountState({
        billing_model: 'per_seat',
        credits: { can_run: false, total: 0.0099614711 },
        subscription: { subscription_id: 'sub_live', status: 'active' },
      }),
    );
    expect(state).toBe('out_of_credits');
    expect(billingStateAllowsRun(state)).toBe(false);
    expect(state).not.toBe('no_subscription');
  });

  test('Team account on an ACTIVE subscription WITH credit is active', () => {
    const state = resolveBillingState(
      accountState({
        billing_model: 'per_seat',
        credits: { can_run: true, total: 25 },
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

describe('the client fallback cannot contradict the server on who bypasses the floor', () => {
  test('a PAST_DUE per-seat account with an empty wallet is payment_failed, not active', () => {
    const state = resolveBillingState(
      accountState({
        billing_model: 'per_seat',
        has_active_subscription: true,
        credits: { can_run: false, total: 0 },
        subscription: { subscription_id: 'sub_dunning', status: 'past_due' },
      }),
    );
    expect(state).toBe('payment_failed');
    expect(billingStateNeedsTopUp(state)).toBe(true);
    expect(billingStateAllowsRun(state)).toBe(false);
  });

  test('an INCOMPLETE_EXPIRED per-seat account is payment_failed, not active', () => {
    expect(
      resolveBillingState(
        accountState({
          billing_model: 'per_seat',
          has_active_subscription: true,
          credits: { can_run: false, total: 0 },
          subscription: { subscription_id: 'sub_never_paid', status: 'incomplete_expired' },
        }),
      ),
    ).toBe('payment_failed');
  });

  test('a past_due per-seat account whose server says it can run is still active', () => {
    expect(
      resolveBillingState(
        accountState({
          billing_model: 'per_seat',
          has_active_subscription: true,
          credits: { can_run: true, total: 25 },
          subscription: { subscription_id: 'sub_dunning', status: 'past_due' },
        }),
      ),
    ).toBe('active');
  });

  test('the server billing_state always wins over the fallback', () => {
    expect(
      resolveBillingState(
        accountState({
          billing_state: 'payment_failed',
          billing_model: 'per_seat',
          has_active_subscription: true,
          credits: { can_run: false, total: 0 },
          subscription: { subscription_id: 'sub_dunning', status: 'past_due' },
        }),
      ),
    ).toBe('payment_failed');
  });

  test('a past_due gate never shows the subscribe pitch', () => {
    const copy = billingGateCopy('payment_failed');
    expect(copy.dialogReason).toBe('insufficient_credits');
    expect(copy.title).not.toContain('Subscribe');
    expect(copy.ctaLabel).toBe('Fix payment');
  });
});

describe('walletSeverity — the ONLY place a balance becomes an alert', () => {
  test('a running account with a healthy wallet is silent', () => {
    expect(walletSeverity(accountState({ billing_state: 'active', credits: { total: 25 } }))).toBe(
      null,
    );
  });

  test('a running account below the low-balance line gets the soft nudge', () => {
    expect(walletSeverity(accountState({ billing_state: 'active', credits: { total: 4.99 } }))).toBe(
      'low',
    );
  });

  test('THE REGRESSION: a $0 wallet on an account the server calls `active` is NOT an alarm', () => {
    // The whole bug in one assertion. The sidebar read `balance <= 0` and
    // rendered a red "Out of credits" row on an account that was starting
    // sessions perfectly well. Severity must follow the state machine.
    //
    // (`active` at exactly $0 is not reachable through the current server rules
    // — the wallet floor blocks first — but the client must never assume the
    // server's rules, which is precisely the assumption that produced the bug.)
    expect(walletSeverity(accountState({ billing_state: 'active', credits: { total: 0 } }))).toBe(
      'low',
    );
  });

  test('a blocked account is `blocked`, whatever the number says', () => {
    expect(
      walletSeverity(accountState({ billing_state: 'out_of_credits', credits: { total: 0 } })),
    ).toBe('blocked');
    expect(
      walletSeverity(accountState({ billing_state: 'payment_failed', credits: { total: -12 } })),
    ).toBe('blocked');
  });

  test('an account with no plan is silent — the subscribe CTA owns that case, not a wallet alert', () => {
    expect(
      walletSeverity(accountState({ billing_state: 'no_subscription', credits: { total: 0 } })),
    ).toBe(null);
    expect(walletSeverity(accountState({ billing_state: 'no_account', credits: { total: 0 } }))).toBe(
      null,
    );
  });

  test('an unloaded account never renders an alarm', () => {
    expect(walletSeverity(null)).toBe(null);
    expect(walletSeverity(undefined)).toBe(null);
  });
});

describe('billingModalCopy — no component writes billing prose', () => {
  test('a voluntary top-up on a healthy account is not an emergency', () => {
    const copy = billingModalCopy('active', { isPerSeat: true });
    expect(copy.title).toBe('Add credits');
    expect(copy.title).not.toBe('Out of credits');
  });

  test('a drained account is told it is out of credits and that its plan survives', () => {
    const copy = billingModalCopy('out_of_credits', { isPerSeat: true });
    expect(copy.title).toBe('Out of credits');
    expect(copy.description).toContain('your Team plan and seats are unaffected');
  });

  test('a NON-per-seat account is never promised seats it does not have', () => {
    const copy = billingModalCopy('out_of_credits', { isPerSeat: false });
    expect(copy.description).not.toContain('seats');
    expect(copy.description).toContain('your plan is unaffected');
  });

  test('a failing payment is never told its plan is unaffected', () => {
    const copy = billingModalCopy('payment_failed', { isPerSeat: true });
    expect(copy.title).toBe('Payment issue on your plan');
    expect(copy.description).not.toContain('unaffected');
  });

  test('every state produces copy — no state falls through to an empty modal', () => {
    for (const state of [
      'active',
      'out_of_credits',
      'payment_failed',
      'no_account',
      'no_subscription',
      null,
    ] as const) {
      const copy = billingModalCopy(state);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.description.length).toBeGreaterThan(0);
    }
  });
});
