import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The chokepoint writes through the credit-accounts repository and invalidates
// the billing cache; stub both so the ownership rules are exercised without a
// database.
const writes: Array<{ fn: 'upsert' | 'update'; accountId: string; patch: Record<string, unknown> }> =
  [];
let storedRow: Record<string, unknown> | null = null;
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => storedRow,
  upsertCreditAccount: async (accountId: string, patch: Record<string, unknown>) => {
    writes.push({ fn: 'upsert', accountId, patch });
  },
  updateCreditAccount: async (accountId: string, patch: Record<string, unknown>) => {
    writes.push({ fn: 'update', accountId, patch });
  },
}));
const invalidated: string[] = [];
mock.module('../billing/services/billing-cache', () => ({
  invalidateAccountBilling: (accountId?: string) => {
    invalidated.push(accountId ?? '*');
  },
}));

const {
  AccountWriteOwnershipError,
  accountIsAdminPinned,
  applyAdminOverride,
  applyStripeSync,
} = await import('../billing/services/account-write-owner');

const ACCT = 'acct_1';
const actor = { userId: 'admin_1', action: 'test.write' };

beforeEach(() => {
  writes.length = 0;
  invalidated.length = 0;
  storedRow = null;
});

describe('applyStripeSync ownership', () => {
  test('throws on an admin-owned field — the caller is buggy, the value is not dropped', async () => {
    await expect(applyStripeSync(ACCT, { enterpriseEntitled: true } as never)).rejects.toThrow(
      AccountWriteOwnershipError,
    );
    expect(writes).toHaveLength(0);
  });

  test('throws on every trial column', async () => {
    await expect(applyStripeSync(ACCT, { trialStatus: 'active' } as never)).rejects.toThrow(
      /admin-owned/,
    );
  });

  // A whole-column write from a webhook would not clobber one field — it would
  // erase every override the account carries at once.
  test('throws on the entitlement_overrides map', async () => {
    await expect(
      applyStripeSync(ACCT, { entitlementOverrides: {} } as never),
    ).rejects.toThrow(/admin-owned field\(s\) entitlementOverrides/);
    expect(writes).toHaveLength(0);
  });

  test("refuses tier='enterprise' outright", async () => {
    await expect(applyStripeSync(ACCT, { tier: 'enterprise' })).rejects.toThrow(
      /entitlement.*not a tier/,
    );
    expect(writes).toHaveLength(0);
  });

  test('pinned account (enterprise_entitled): tier is skipped, every other provider fact lands', async () => {
    storedRow = { tier: 'per_seat', enterpriseEntitled: true };
    await applyStripeSync(ACCT, { tier: 'per_seat', seatCount: 5, billingModel: 'per_seat' });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.patch).toEqual({ seatCount: 5, billingModel: 'per_seat' });
    expect(invalidated).toEqual([ACCT]);
  });

  test("pinned via legacy tier='enterprise' row: same skip", async () => {
    storedRow = { tier: 'enterprise', enterpriseEntitled: false };
    await applyStripeSync(ACCT, { tier: 'per_seat', stripeSubscriptionStatus: 'active' });
    expect(writes[0]!.patch).toEqual({ stripeSubscriptionStatus: 'active' });
  });

  test('unpinned account: the tier write goes through', async () => {
    storedRow = { tier: 'free', enterpriseEntitled: false };
    await applyStripeSync(ACCT, { tier: 'per_seat' });
    expect(writes[0]!.patch).toEqual({ tier: 'per_seat' });
  });

  test('pin rule leaving an empty patch skips the write entirely', async () => {
    storedRow = { tier: 'per_seat', enterpriseEntitled: true };
    await applyStripeSync(ACCT, { tier: 'free' });
    expect(writes).toHaveLength(0);
  });

  test("mode 'update' never conjures a row (updateCreditAccount, not upsert)", async () => {
    await applyStripeSync(ACCT, { paymentStatus: 'past_due' }, { mode: 'update', account: null });
    expect(writes[0]!.fn).toBe('update');
  });

  test('ctx.account skips the row lookup and still pins', async () => {
    await applyStripeSync(
      ACCT,
      { tier: 'free', seatCount: 1 },
      { account: { tier: 'per_seat', enterpriseEntitled: true } },
    );
    expect(writes[0]!.patch).toEqual({ seatCount: 1 });
  });
});

describe('applyAdminOverride ownership', () => {
  test('throws on a provider-owned field', async () => {
    await expect(
      applyAdminOverride(ACCT, { stripeSubscriptionId: 'sub_x' } as never, actor),
    ).rejects.toThrow(/provider-owned/);
    expect(writes).toHaveLength(0);
  });

  test('tier is the one admin-assignable provider field', async () => {
    await applyAdminOverride(ACCT, { tier: 'per_seat' }, actor);
    expect(writes[0]!.patch).toEqual({ tier: 'per_seat' });
    expect(invalidated).toEqual([ACCT]);
  });

  test("but never tier='enterprise'", async () => {
    await expect(applyAdminOverride(ACCT, { tier: 'enterprise' }, actor)).rejects.toThrow(
      /entitlement.*not a tier/,
    );
  });

  test('admin-owned fields write through', async () => {
    await applyAdminOverride(ACCT, { enterpriseEntitled: true, maxConcurrentSessions: 500 }, actor);
    expect(writes[0]!.patch).toEqual({ enterpriseEntitled: true, maxConcurrentSessions: 500 });
  });

  test('the entitlement_overrides map is admin-owned too', async () => {
    const overrides = { sso: { value: true, expires_at: '2026-12-01T00:00:00.000Z' } };
    await applyAdminOverride(ACCT, { entitlementOverrides: overrides }, actor);
    expect(writes[0]!.patch).toEqual({ entitlementOverrides: overrides });
    expect(invalidated).toEqual([ACCT]);
  });
});

describe('accountIsAdminPinned', () => {
  test('no row → not pinned', () => {
    expect(accountIsAdminPinned(null)).toBe(false);
  });
  test('enterprise_entitled pins; plain per_seat does not', () => {
    expect(accountIsAdminPinned({ tier: 'per_seat', enterpriseEntitled: true })).toBe(true);
    expect(accountIsAdminPinned({ tier: 'per_seat', enterpriseEntitled: false })).toBe(false);
    expect(accountIsAdminPinned({ tier: 'enterprise', enterpriseEntitled: false })).toBe(true);
  });
});
