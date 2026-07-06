/**
 * Unit test for the concurrent-session-limit POLICY: `resolveAccountSessionLimit`.
 * Resolution order: billing disabled → effectively unlimited; a positive
 * `credit_accounts.max_concurrent_sessions` (operator-set per-account override)
 * → wins over the tier in both directions; otherwise the plan tier's
 * `TierConfig.concurrentSessionLimit`. The HTTP 429 enforcement of this number
 * lives in `e2e-project-session-contract.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { getTier } from '../../billing/services/tiers';

// Mutable knobs the mocks read.
let billingEnabled = true;
let currentTier: string | null = 'free';
let currentOverride: number | null = null;

// A Proxy config so any unrelated key read elsewhere is a harmless `undefined`;
// only KORTIX_BILLING_INTERNAL_ENABLED matters to the policy.
mock.module('../../config', () => ({
  config: new Proxy(
    {},
    {
      get: (_t, key) => (key === 'KORTIX_BILLING_INTERNAL_ENABLED' ? billingEnabled : undefined),
    },
  ),
}));

mock.module('../../billing/repositories/credit-accounts', () => ({
  upsertCreditAccount: async () => undefined,
  getSubscriptionInfo: async () =>
    currentTier === null && currentOverride === null
      ? null
      : { tier: currentTier, maxConcurrentSessions: currentOverride },
}));

const { resolveAccountSessionLimit, maxConcurrentSessionsForTier, clearAccountLimitCache } =
  await import('../../shared/account-limits');

// Distinct account id per call keeps the 60s cache from bleeding across cases;
// clearAccountLimitCache() in beforeEach is belt-and-suspenders.
let n = 0;
const nextAccount = () => `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`;

describe('resolveAccountSessionLimit — tier vs per-account override', () => {
  beforeEach(() => {
    clearAccountLimitCache();
    billingEnabled = true;
    currentTier = 'free';
    currentOverride = null;
  });

  test('no override → the plan tier decides (per_seat keeps its 200)', async () => {
    currentTier = 'per_seat';
    expect(await resolveAccountSessionLimit(nextAccount())).toEqual({
      tier: 'per_seat',
      limit: getTier('per_seat').concurrentSessionLimit,
      source: 'tier',
    });
  });

  test('no subscription row (null) falls back to the free-tier cap', async () => {
    currentTier = null;
    const resolved = await resolveAccountSessionLimit(nextAccount());
    expect(resolved.limit).toBe(getTier('free').concurrentSessionLimit);
    expect(resolved.source).toBe('tier');
  });

  test('override wins over the tier (raise: 100000 on per_seat)', async () => {
    currentTier = 'per_seat';
    currentOverride = 100_000;
    expect(await resolveAccountSessionLimit(nextAccount())).toEqual({
      tier: 'per_seat',
      limit: 100_000,
      source: 'account_override',
    });
  });

  test('override wins over the tier (lower: abuse containment)', async () => {
    currentTier = 'enterprise';
    currentOverride = 2;
    const resolved = await resolveAccountSessionLimit(nextAccount());
    expect(resolved.limit).toBe(2);
    expect(resolved.source).toBe('account_override');
  });

  test('non-positive override is ignored — tier decides', async () => {
    currentTier = 'pro';
    currentOverride = 0;
    const resolved = await resolveAccountSessionLimit(nextAccount());
    expect(resolved.limit).toBe(getTier('pro').concurrentSessionLimit);
    expect(resolved.source).toBe('tier');
  });

  test('billing disabled → effectively unlimited, override irrelevant', async () => {
    billingEnabled = false;
    currentOverride = 5;
    expect(await resolveAccountSessionLimit(nextAccount())).toEqual({
      tier: null,
      limit: Number.MAX_SAFE_INTEGER,
      source: 'billing_disabled',
    });
    expect(maxConcurrentSessionsForTier('per_seat')).toBe(Number.MAX_SAFE_INTEGER);
  });
});
