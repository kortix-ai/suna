import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * BILLING-CORRECTNESS: checkBillingActive used to be a read-only
 * `balance >= MINIMUM_CREDIT_FOR_RUN` check, fully decoupled from the real
 * per-request deduction that only happens once the whole (possibly
 * long-running, streaming) request settles — N concurrent requests could all
 * read the same stale balance and all get admitted. This now takes an ATOMIC
 * admission hold (via the same row-locked `atomic_use_credits` DB function
 * the real deduction uses) on the pure-wallet path, returning `holdUsd` so the
 * caller (llm-gateway hooks.recordGatewayUsage) reconciles it to the real
 * cost at settle. This file covers: the hold IS taken on the wallet path, is
 * NOT taken for an active per-seat subscription or a self-host/billing-off
 * deploy, and a failed hold (insufficient credits) surfaces as
 * `insufficient_credits` — the same denial the old read-only check produced.
 */

let creditAccount: {
  balance: number;
  billingModel: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
} | null = null;
let billingInternalEnabled = true;
let deductCreditsCalls: Array<{ accountId: string; amount: number }> = [];
let deductShouldFail = false;

mock.module('../config', () => ({
  config: {
    get KORTIX_BILLING_INTERNAL_ENABLED() {
      return billingInternalEnabled;
    },
  },
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => creditAccount,
}));

mock.module('../billing/services/free-tier', () => ({
  ensureFreeTierAccountReady: async () => {},
}));

mock.module('../billing/services/credits', () => ({
  deductCredits: async (accountId: string, amount: number) => {
    deductCreditsCalls.push({ accountId, amount });
    if (deductShouldFail) {
      throw new Error('Insufficient credits');
    }
    return { success: true, cost: amount, newBalance: 0, transactionId: 'txn-1' };
  },
  grantCredits: async () => ({ success: true }),
}));

const { checkBillingActive } = await import('../billing/services/billing-gate');

describe('checkBillingActive — atomic admission hold (pure-wallet path)', () => {
  beforeEach(() => {
    billingInternalEnabled = true;
    deductCreditsCalls = [];
    deductShouldFail = false;
    creditAccount = {
      balance: 5,
      billingModel: 'wallet',
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
    };
  });

  test('a solvent wallet account gets an ATOMIC hold taken (not just a read check) and holdUsd is returned', async () => {
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(true);
    expect((result as { holdUsd?: number }).holdUsd).toBe(0.01);
    // The critical behavioral change: this is a real deduction call through
    // the SAME atomic path the final charge uses, not a passive balance read.
    expect(deductCreditsCalls).toHaveLength(1);
    expect(deductCreditsCalls[0]).toEqual({ accountId: 'acct-1', amount: 0.01 });
  });

  test('a hold that fails (concurrent drain / insufficient balance) denies with insufficient_credits — same denial shape as the old read check', async () => {
    deductShouldFail = true;
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('insufficient_credits');
    }
  });

  test('no credit account at all → no_account, no hold attempted', async () => {
    creditAccount = null;
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_account');
    expect(deductCreditsCalls).toHaveLength(0);
  });

  test('an active per-seat subscription bypasses the wallet floor entirely — no hold taken', async () => {
    creditAccount = {
      balance: 0,
      billingModel: 'per_seat',
      stripeSubscriptionId: 'sub_123',
      stripeSubscriptionStatus: 'active',
    };
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(true);
    expect((result as { holdUsd?: number }).holdUsd).toBeUndefined();
    expect(deductCreditsCalls).toHaveLength(0);
  });

  test('a per-seat account with no active subscription falls back to the wallet-floor check (no hold — subscription_required, not insufficient_credits)', async () => {
    creditAccount = {
      balance: 0,
      billingModel: 'per_seat',
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
    };
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('subscription_required');
    expect(deductCreditsCalls).toHaveLength(0);
  });

  test('self-host / billing-internal-disabled deploys skip the gate entirely — no hold, always ok', async () => {
    billingInternalEnabled = false;
    const result = await checkBillingActive('acct-1');
    expect(result.ok).toBe(true);
    expect((result as { holdUsd?: number }).holdUsd).toBeUndefined();
    expect(deductCreditsCalls).toHaveLength(0);
  });
});
