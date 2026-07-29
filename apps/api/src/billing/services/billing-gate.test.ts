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

// The whole module is replaced, so every symbol `./credits` imports from it has
// to exist here — without `updateCreditAccount` the import of `./credits`
// (deductCredits, on the pure-wallet admission-hold path) fails to link and the
// entire file errors out before a single test runs.
mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => account,
  getCreditBalance: async () => null,
  updateCreditAccount: async () => undefined,
  upsertCreditAccount: async () => undefined,
}));

// The admission hold is a real row-locked DB write in production; here it is
// emulated against the fixture balance — it succeeds when the wallet can cover
// the floor and throws when it cannot, exactly like `atomic_use_credits`.
mock.module('./credits', () => ({
  deductCredits: async (_accountId: string, amount: number) => {
    if (Number(account?.balance ?? 0) < amount) throw new Error('insufficient credits');
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
    if (!result.ok) expect(result.reason).toBe('no_account');
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
      expect(result.billingModel).toBe('per_seat');
      expect(result.hasSubscription).toBe(false);
    }
  });

  test('per-seat Team account WITH a lapsed subscription and a drained wallet → "insufficient_credits" (top up, not "subscribe from Free")', async () => {
    billingEnabled = true;
    // Has a real subscription row (id set) but it lapsed to unpaid, and the
    // wallet is deep negative — this is the exact "$-9k Team account" case. It
    // must NOT be pitched the Free plan; it's out of credits.
    account = creditAccount({
      billingModel: 'per_seat',
      balance: '-9237.85',
      stripeSubscriptionId: 'sub_lapsed',
      stripeSubscriptionStatus: 'unpaid',
    });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('insufficient_credits');
      expect(result.billingModel).toBe('per_seat');
      expect(result.hasSubscription).toBe(true);
      expect(result.balance).toBe(-9237.85);
    }
  });

  test('legacy (non-per-seat) account with an exhausted balance → "insufficient_credits", NOT subscription_required', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', balance: '0' });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient_credits');
  });

  test('a funded legacy account is ok', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', balance: '5.00' });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(true);
  });

  test('per-seat account on an ACTIVE subscription with a drained wallet is admitted (not wallet-gated)', async () => {
    billingEnabled = true;
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '0.0099614711',
      stripeSubscriptionId: 'sub_live',
      stripeSubscriptionStatus: 'active',
    });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.holdUsd).toBeUndefined();
  });
});

describe('checkBillingActive — billingState is the unambiguous discriminator', () => {
  test('a drained Team account that HAS a plan reports out_of_credits, never no_subscription', async () => {
    billingEnabled = true;
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '0',
      stripeSubscriptionId: 'sub_gone',
      stripeSubscriptionStatus: 'canceled',
    });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.billingState).toBe('out_of_credits');
      expect(result.reason).toBe('insufficient_credits');
    }
  });

  test('a never-subscribed per-seat account reports no_subscription', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'per_seat', balance: '0' });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.billingState).toBe('no_subscription');
      expect(result.reason).toBe('subscription_required');
    }
  });

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

  test('a drained legacy PAID account reports out_of_credits', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', tier: 'tier_2_20', balance: '0' });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.billingState).toBe('out_of_credits');
  });

  test('no credit account reports no_account', async () => {
    billingEnabled = true;
    account = null;
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.billingState).toBe('no_account');
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

  test('insufficient_credits and subscription_required are distinguishable via `.reason`', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', balance: '0' });
    let creditsErr: unknown;
    try {
      await assertBillingActive('acct-1');
    } catch (err) {
      creditsErr = err;
    }
    expect((creditsErr as InstanceType<typeof BillingGateError>).reason).toBe(
      'insufficient_credits',
    );

    account = creditAccount({
      billingModel: 'per_seat',
      balance: '0',
      stripeSubscriptionStatus: 'canceled',
    });
    let subErr: unknown;
    try {
      await assertBillingActive('acct-1');
    } catch (err) {
      subErr = err;
    }
    expect((subErr as InstanceType<typeof BillingGateError>).reason).toBe('subscription_required');
    expect((subErr as InstanceType<typeof BillingGateError>).reason).not.toBe(
      (creditsErr as InstanceType<typeof BillingGateError>).reason,
    );
  });

  test('the thrown error still carries the JSON response body with `code` for callers reading the Response directly', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'legacy', balance: '0' });
    try {
      await assertBillingActive('acct-1');
      throw new Error('expected assertBillingActive to throw');
    } catch (err) {
      const gateError = err as InstanceType<typeof BillingGateError>;
      const body = await gateError.res!.clone().json();
      expect(body.code).toBe('insufficient_credits');
    }
  });

  test('the 402 body carries billing_model + has_subscription so the client can route to top-up vs subscribe', async () => {
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
      expect(body.billing_model).toBe('per_seat');
      expect(body.has_subscription).toBe(true);
    }
  });

  test('the 402 body carries billing_state so a drained Team wallet is never rendered as "no plan"', async () => {
    billingEnabled = true;
    account = creditAccount({
      billingModel: 'per_seat',
      tier: 'per_seat',
      balance: '0',
      stripeSubscriptionId: 'sub_gone',
      stripeSubscriptionStatus: 'canceled',
    });
    try {
      await assertBillingActive('acct-1');
      throw new Error('expected assertBillingActive to throw');
    } catch (err) {
      const gateError = err as InstanceType<typeof BillingGateError>;
      const body = await gateError.res!.clone().json();
      expect(body.billing_state).toBe('out_of_credits');
      expect(body.billing_state).not.toBe('no_subscription');
    }
  });
});
