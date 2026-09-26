import { describe, expect, mock, test } from 'bun:test';

// checkBillingActive/assertBillingActive read `config.KORTIX_BILLING_INTERNAL_ENABLED`
// and delegate account lookup to getCreditAccount + ensureFreeTierAccountReady.
// Mocked so this file can drive every branch (no_account / insufficient_credits /
// subscription_required / ok) without a real DB or Stripe state.
let billingEnabled = true;
let account: Record<string, unknown> | null = null;

mock.module('../../config', () => ({
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (Object.hasOwn(target, key)) return target[key];
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return billingEnabled;
        return target[key];
      },
    },
  ),
}));

mock.module('./free-tier', () => ({
  ensureFreeTierAccountReady: async () => undefined,
}));

// The whole module is replaced, so every symbol the gate's import graph reads
// from it has to exist here, or the file fails to link before a test runs.
mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => account,
  getCreditBalance: async () => null,
  updateCreditAccount: async () => undefined,
  upsertCreditAccount: async () => undefined,
}));

// The admission hold is a real row-locked DB write in production; here it is
// emulated against the fixture balance — it succeeds when the wallet can cover
// the floor and throws when it cannot, exactly like `atomic_use_credits`.
const holdCalls: number[] = [];

mock.module('../wallet', () => ({
  wallet: {
    debit: async (input: { amount: number }) => {
      holdCalls.push(input.amount);
      if (Number(account?.balance ?? 0) < input.amount) throw new Error('insufficient credits');
      return { amount: input.amount, balance: 0, transactionId: 'tx', replayed: false };
    },
  },
}));

const { assertBillingActive, checkBillingActive, BillingGateError } = await import(
  './billing-gate'
);

function creditAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    balance: '100.00',
    billingModel: 'legacy',
    tier: 'free',
    paymentStatus: 'active',
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    ...overrides,
  };
}

// An upload admission (a prompt attachment `begin`) spends no compute. It must
// take the prompt path's decision without the admission hold: only an LLM
// gateway settle reconciles that hold, so a hold per upload is never refunded.
describe('checkBillingAdmission — the prompt path decision without a hold', () => {
  test('a funded account is admitted and no credits are deducted', async () => {
    const { checkBillingAdmission } = await import('./billing-gate');
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', balance: '5.00' });
    holdCalls.length = 0;
    expect(await checkBillingAdmission('acct-1')).toEqual({ ok: true });
    expect(holdCalls).toEqual([]);
  });

  test('a drained account gets the same blocked result checkBillingActive returns', async () => {
    const { checkBillingAdmission } = await import('./billing-gate');
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', balance: '0' });
    holdCalls.length = 0;
    const admission = await checkBillingAdmission('acct-1');
    expect(admission.ok).toBe(false);
    expect(admission).toEqual(await checkBillingActive('acct-1'));
    expect(holdCalls).toEqual([]);
  });

  test('billing disabled admits every account', async () => {
    const { checkBillingAdmission } = await import('./billing-gate');
    billingEnabled = false;
    account = null;
    expect(await checkBillingAdmission('acct-1')).toEqual({ ok: true });
    billingEnabled = true;
  });
});

describe('checkBillingActive — real reason per gate (ERROR-TAXONOMY finding #4)', () => {
  test('billing disabled (self-host): always ok, regardless of account state', async () => {
    billingEnabled = false;
    account = null;
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(true);
  });

  test('no credit account at all → reason "no_account"', async () => {
    billingEnabled = true;
    account = null;
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_account');
      expect(result.billingState).toBe('no_account');
    }
  });

  test('per-seat account that NEVER subscribed (no subscription row) and insufficient balance → "subscription_required"', async () => {
    billingEnabled = true;
    account = creditAccount({
      billingModel: 'per_seat',
      balance: '0',
      stripeSubscriptionStatus: 'canceled',
    });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('subscription_required');
      expect(result.billingState).toBe('no_subscription');
      expect(result.billingModel).toBe('per_seat');
      expect(result.hasSubscription).toBe(false);
    }
  });

  test('per-seat account on an ACTIVE subscription with a drained wallet is REFUSED (the floor is universal)', async () => {
    // Was: admitted with no hold, because a paying per-seat subscription
    // bypassed the wallet floor. That is the exact shape that spent $588.81
    // against a $150 seat grant on a $0 wallet. It now 402s like anyone else.
    billingEnabled = true;
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '0.0099614711',
      stripeSubscriptionId: 'sub_live',
      stripeSubscriptionStatus: 'active',
    });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.billingState).toBe('out_of_credits');
      expect(result.reason).toBe('insufficient_credits');
      // Still recognised as a paying customer, so the client says "Top up".
      expect(result.hasSubscription).toBe(true);
      expect(result.billingModel).toBe('per_seat');
    }
  });
});

describe('checkBillingActive — billingState is the unambiguous discriminator', () => {
  test('a drained FREE account reports no_subscription even though its 402 code stays insufficient_credits', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', tier: 'free', balance: '0' });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.billingState).toBe('no_subscription');
      expect(result.reason).toBe('insufficient_credits');
    }
  });

  test('a drained legacy PAID account reports out_of_credits with the legacy top-up message', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', tier: 'tier_2_20', balance: '0' });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.billingState).toBe('out_of_credits');
      expect(result.reason).toBe('insufficient_credits');
      expect(result.message).toBe('Out of credits. Top up to continue.');
    }
  });

});

describe('assertBillingActive / BillingGateError — the reason survives the throw (not hardcoded)', () => {
  test('throws BillingGateError carrying the real reason as `.reason`, not a generic constant', async () => {
    billingEnabled = true;
    account = null; // no_account
    let caught: unknown;
    try {
      await assertBillingActive('acct-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BillingGateError);
    expect((caught as InstanceType<typeof BillingGateError>).reason).toBe('no_account');
  });

  test('the 402 body carries the blocked account, its balance, billing_model and has_subscription', async () => {
    // The exact "$-9k Team account" case: a real subscription row that lapsed
    // to unpaid and a deep-negative wallet. The client routes it to top-up, not
    // to "subscribe from Free", and scopes the upgrade dialog to account_id.
    billingEnabled = true;
    account = creditAccount({
      billingModel: 'per_seat',
      balance: '-9237.85',
      stripeSubscriptionId: 'sub_lapsed',
      stripeSubscriptionStatus: 'unpaid',
    });
    try {
      await assertBillingActive('acct-1');
      throw new Error('expected assertBillingActive to throw');
    } catch (err) {
      const gateError = err as InstanceType<typeof BillingGateError>;
      const body = await gateError.res!.clone().json();
      expect(body.code).toBe('insufficient_credits');
      expect(body.account_id).toBe('acct-1');
      expect(body.balance).toBe(-9237.85);
      expect(body.billing_model).toBe('per_seat');
      expect(body.has_subscription).toBe(true);
    }
  });

  test.each([
    // A drained Team wallet is never rendered as "no plan".
    ['canceled', 'active', 'out_of_credits'],
    // A failing card is told to fix payment, not to subscribe.
    ['past_due', 'past_due', 'payment_failed'],
  ])('the 402 body of a drained per-seat "%s" subscription (payment status "%s") carries billing_state "%s"', async (status, paymentStatus, state) => {
    billingEnabled = true;
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '0',
      stripeSubscriptionId: 'sub_x',
      stripeSubscriptionStatus: status,
      paymentStatus,
    });
    try {
      await assertBillingActive('acct-1');
      throw new Error('expected assertBillingActive to throw');
    } catch (err) {
      const gateError = err as InstanceType<typeof BillingGateError>;
      const body = await gateError.res!.clone().json();
      expect(body.billing_state).toBe(state);
      expect(body.code).toBe('insufficient_credits');
      expect(body.has_subscription).toBe(true);
    }
  });

});

describe('the wallet floor applies to every subscription that is not paying', () => {
  test('an ACTIVE per-seat subscription WITH credit takes the hold like everyone else', async () => {
    billingEnabled = true;
    holdCalls.length = 0;
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '25',
      stripeSubscriptionId: 'sub_live',
      stripeSubscriptionStatus: 'active',
    });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.holdUsd).toBe(0.01);
    expect(holdCalls.length).toBe(1);
  });

  test('a PAST_DUE per-seat account with an empty wallet is blocked as payment_failed, not "subscribe"', async () => {
    billingEnabled = true;
    holdCalls.length = 0;
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '0',
      stripeSubscriptionId: 'sub_dunning',
      stripeSubscriptionStatus: 'past_due',
      paymentStatus: 'past_due',
    });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.billingState).toBe('payment_failed');
      expect(result.reason).toBe('insufficient_credits');
      expect(result.reason).not.toBe('subscription_required');
      expect(result.message).toContain('payment');
    }
  });

});
