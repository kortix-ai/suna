import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * BILLING-CORRECTNESS: account tier used to be cached in TWO independent 30s
 * TTL maps (entitlements.ts's own `getCachedAccountTier`, and a byte-for-byte
 * duplicate in llm-gateway/resolution/resolve-candidates.ts) gating two
 * different billing decisions — the BYOK platform-fee/waiver branch and the
 * managed-model free-tier gate could disagree for up to 30s after a tier
 * change, independently, because each read a different cache with its own
 * expiry clock. resolve-candidates.ts now calls getCachedAccountTier and
 * accountMayUseManagedModels directly, so there is exactly one cache and one
 * invalidation point. This file proves that single cache's own contract: the
 * 30 000 ms TTL boundary, and a tier change mid-window that is only picked up
 * once invalidated (or once the TTL expires).
 */

let fakeTier = 'free';
let getAccountTierCalls = 0;

mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => {
    getAccountTierCalls += 1;
    return { tier: fakeTier };
  },
}));

mock.module('../config', () => ({
  config: { ENTERPRISE_LICENSE_AVAILABLE: false },
}));

const { getCachedAccountTier, invalidateCachedAccountTier } = await import(
  '../billing/services/entitlements'
);

describe('getCachedAccountTier — the single unified tier cache', () => {
  beforeEach(() => {
    fakeTier = 'free';
    getAccountTierCalls = 0;
    invalidateCachedAccountTier();
  });

  test('a repeated read within the TTL window is served from cache (one DB read)', async () => {
    const acct = 'acct-cache-hit';
    expect(await getCachedAccountTier(acct)).toBe('free');
    expect(await getCachedAccountTier(acct)).toBe('free');
    expect(await getCachedAccountTier(acct)).toBe('free');
    expect(getAccountTierCalls).toBe(1);
  });

  test('the TTL is exactly 30 000 ms: a read at +29 999 ms is cached, a read at +30 000 ms reloads', async () => {
    const acct = 'acct-ttl-boundary';
    expect(await getCachedAccountTier(acct, 10_000)).toBe('free');

    fakeTier = 'per_seat';
    expect(await getCachedAccountTier(acct, 10_000 + 29_999)).toBe('free');
    expect(getAccountTierCalls).toBe(1);

    expect(await getCachedAccountTier(acct, 10_000 + 30_000)).toBe('per_seat');
    expect(getAccountTierCalls).toBe(2);
  });

  test('a tier change mid-window is invisible until the cache is invalidated — the exact skew the two-cache bug caused', async () => {
    const acct = 'acct-tier-change';
    expect(await getCachedAccountTier(acct)).toBe('free');

    // Account upgrades — but the cached read still returns the stale tier
    // until something busts the cache (this is the real, documented behavior
    // of a 30s TTL cache; the bug fixed here is that there used to be a
    // SECOND independent cache that could disagree with this one about WHEN
    // that staleness ends).
    fakeTier = 'per_seat';
    expect(await getCachedAccountTier(acct)).toBe('free');
    expect(getAccountTierCalls).toBe(1);

    invalidateCachedAccountTier(acct);
    expect(await getCachedAccountTier(acct)).toBe('per_seat');
    expect(getAccountTierCalls).toBe(2);
  });

  test('invalidateCachedAccountTier() with no id clears every cached account', async () => {
    await getCachedAccountTier('acct-a');
    await getCachedAccountTier('acct-b');
    expect(getAccountTierCalls).toBe(2);

    fakeTier = 'enterprise';
    invalidateCachedAccountTier();

    expect(await getCachedAccountTier('acct-a')).toBe('enterprise');
    expect(await getCachedAccountTier('acct-b')).toBe('enterprise');
    expect(getAccountTierCalls).toBe(4);
  });

  test('different accounts are cached independently', async () => {
    fakeTier = 'free';
    expect(await getCachedAccountTier('acct-1')).toBe('free');
    fakeTier = 'per_seat';
    expect(await getCachedAccountTier('acct-2')).toBe('per_seat');
    // acct-1 stays cached at 'free' even though the mock now returns
    // 'per_seat' for any new (uncached) read.
    expect(await getCachedAccountTier('acct-1')).toBe('free');
    expect(getAccountTierCalls).toBe(2);
  });
});
