import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The single account-billing cache (billing-cache.ts). It replaced two caches
 * over the same credit_accounts row — a 30s tier cache in entitlements.ts and a
 * 60s limit cache in shared/account-limits.ts — which is why this file pins the
 * three properties everything else now depends on:
 *   1. a repeat read inside the TTL does not touch the database;
 *   2. invalidation (per-account and global) makes the next read live;
 *   3. `fresh` and a caller-supplied `row` both bypass the cached value.
 */

let row: Record<string, unknown> | null = { tier: 'free' };
let reads = 0;

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => {
    reads += 1;
    return row;
  },
}));

const { BILLING_CACHE_TTL_MS, invalidateAccountBilling, resolveAccountBilling } = await import(
  './billing-cache'
);

describe('resolveAccountBilling — the one billing cache', () => {
  beforeEach(() => {
    invalidateAccountBilling();
    row = { tier: 'free' };
    reads = 0;
  });

  test('a repeated read inside the TTL is served from cache (one DB read)', async () => {
    expect((await resolveAccountBilling('acct-1', { now: 1_000 })).plan.key).toBe('free');
    expect((await resolveAccountBilling('acct-1', { now: 1_000 })).plan.key).toBe('free');
    expect(reads).toBe(1);
  });

  test('a plan change mid-window is invisible until the entry expires', async () => {
    expect((await resolveAccountBilling('acct-1', { now: 1_000 })).plan.key).toBe('free');
    row = { tier: 'per_seat' };

    expect(
      (await resolveAccountBilling('acct-1', { now: 1_000 + BILLING_CACHE_TTL_MS - 1 })).plan.key,
    ).toBe('free');
    expect(reads).toBe(1);

    expect(
      (await resolveAccountBilling('acct-1', { now: 1_000 + BILLING_CACHE_TTL_MS })).plan.key,
    ).toBe('per_seat');
    expect(reads).toBe(2);
  });

  test('set → invalidate → fresh read: invalidating one account re-reads it', async () => {
    expect((await resolveAccountBilling('acct-1')).plan.key).toBe('free');
    row = { tier: 'enterprise' };
    expect((await resolveAccountBilling('acct-1')).plan.key).toBe('free');

    invalidateAccountBilling('acct-1');

    expect((await resolveAccountBilling('acct-1')).plan.key).toBe('enterprise');
    expect(reads).toBe(2);
  });

  test('invalidateAccountBilling() with no id clears every account', async () => {
    await resolveAccountBilling('acct-a');
    await resolveAccountBilling('acct-b');
    expect(reads).toBe(2);

    row = { tier: 'pro' };
    invalidateAccountBilling();

    expect((await resolveAccountBilling('acct-a')).plan.key).toBe('pro');
    expect((await resolveAccountBilling('acct-b')).plan.key).toBe('pro');
    expect(reads).toBe(4);
  });

  test('accounts are cached independently of one another', async () => {
    expect((await resolveAccountBilling('acct-1')).plan.key).toBe('free');
    row = { tier: 'per_seat' };
    expect((await resolveAccountBilling('acct-2')).plan.key).toBe('per_seat');
    expect((await resolveAccountBilling('acct-1')).plan.key).toBe('free');
    expect(reads).toBe(2);
  });

  test('{ fresh: true } bypasses the cached value and refreshes it', async () => {
    expect((await resolveAccountBilling('acct-1')).plan.key).toBe('free');
    row = { tier: 'pro' };

    expect((await resolveAccountBilling('acct-1', { fresh: true })).plan.key).toBe('pro');
    expect(reads).toBe(2);
    // …and the fresh answer is what the next cached read serves.
    expect((await resolveAccountBilling('acct-1')).plan.key).toBe('pro');
    expect(reads).toBe(2);
  });

  test('a caller-supplied row skips the read entirely and seeds the cache', async () => {
    const resolved = await resolveAccountBilling('acct-1', { row: { tier: 'tier_25_200' } });
    expect(resolved.plan.key).toBe('tier_25_200');
    expect(reads).toBe(0);

    expect((await resolveAccountBilling('acct-1')).plan.key).toBe('tier_25_200');
    expect(reads).toBe(0);
  });

  test('row: null means "no credit row", not "go fetch it" — fail-closed to none', async () => {
    const resolved = await resolveAccountBilling('acct-1', { row: null });
    expect(resolved.plan.key).toBe('none');
    expect(resolved.source).toBe('no_account');
    expect(reads).toBe(0);
  });

  test('an active trial resolves to the trial plan, not the stored tier', async () => {
    row = {
      tier: 'free',
      trialStatus: 'active',
      trialTier: 'tier_25_200',
      trialEndsAt: new Date(10_000 + 86_400_000).toISOString(),
    };

    const resolved = await resolveAccountBilling('acct-trial', { now: 10_000 });
    expect(resolved.plan.key).toBe('tier_25_200');
    expect(resolved.source).toBe('trial');
  });
});
