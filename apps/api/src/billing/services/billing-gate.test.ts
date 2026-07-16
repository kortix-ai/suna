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

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => account,
}));

const { assertBillingActive, checkBillingActive, BillingGateError } = await import('./billing-gate');

function creditAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    balance: '100.00',
    billingModel: 'legacy',
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

  test('per-seat account with no active subscription and insufficient balance → "subscription_required"', async () => {
    billingEnabled = true;
    account = creditAccount({ billingModel: 'per_seat', balance: '0', stripeSubscriptionStatus: 'canceled' });
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('subscription_required');
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
    expect((creditsErr as InstanceType<typeof BillingGateError>).reason).toBe('insufficient_credits');

    account = creditAccount({ billingModel: 'per_seat', balance: '0', stripeSubscriptionStatus: 'canceled' });
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
});
