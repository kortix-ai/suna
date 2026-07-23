/**
 * Unit test for the project-limit POLICY: `maxProjectsForAccount` — the
 * plan→max-project-count mapping. Free (and the placeholder `none`) →
 * `FREE_TIER_PROJECT_LIMIT`; any paid tier → `MAX_PROJECTS_PER_ACCOUNT`;
 * Enterprise → uncapped; billing disabled (local / self-hosted) → uncapped.
 * The HTTP enforcement of this number lives in `e2e-project-limit.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { MAX_PROJECTS_PER_ACCOUNT } from '../billing/services/tiers';

// Mutable knobs the mocks read.
let billingEnabled = true;
let currentTier: string | null = 'free';

// A Proxy config so any unrelated key read elsewhere is a harmless `undefined`;
// only KORTIX_BILLING_INTERNAL_ENABLED matters to the policy.
mock.module('../config', () => ({
  config: new Proxy(
    {},
    {
      get: (_t, key) => (key === 'KORTIX_BILLING_INTERNAL_ENABLED' ? billingEnabled : undefined),
    },
  ),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  upsertCreditAccount: async () => undefined,
  getSubscriptionInfo: async () => (currentTier === null ? null : { tier: currentTier }),
}));

const { maxProjectsForAccount, FREE_TIER_PROJECT_LIMIT, clearAccountLimitCache } = await import(
  '../shared/account-limits'
);

// Distinct account id per call keeps the 60s tier cache from bleeding across
// cases; clearAccountLimitCache() in beforeEach is belt-and-suspenders.
let n = 0;
const nextAccount = () => `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`;

describe('maxProjectsForAccount — plan → project cap', () => {
  beforeEach(() => {
    clearAccountLimitCache();
    billingEnabled = true;
    currentTier = 'free';
  });

  test('free tier → FREE_TIER_PROJECT_LIMIT (3)', async () => {
    currentTier = 'free';
    expect(FREE_TIER_PROJECT_LIMIT).toBe(3);
    expect(await maxProjectsForAccount(nextAccount())).toBe(FREE_TIER_PROJECT_LIMIT);
  });

  test('no subscription row (null) is treated as free', async () => {
    currentTier = null;
    expect(await maxProjectsForAccount(nextAccount())).toBe(FREE_TIER_PROJECT_LIMIT);
  });

  test("placeholder 'none' tier → free limit", async () => {
    currentTier = 'none';
    expect(await maxProjectsForAccount(nextAccount())).toBe(FREE_TIER_PROJECT_LIMIT);
  });

  test('per-seat (team) plan → MAX_PROJECTS_PER_ACCOUNT', async () => {
    currentTier = 'per_seat';
    expect(await maxProjectsForAccount(nextAccount())).toBe(MAX_PROJECTS_PER_ACCOUNT);
  });

  test('pro plan → MAX_PROJECTS_PER_ACCOUNT', async () => {
    currentTier = 'pro';
    expect(await maxProjectsForAccount(nextAccount())).toBe(MAX_PROJECTS_PER_ACCOUNT);
  });

  test('legacy paid tier → MAX_PROJECTS_PER_ACCOUNT (any non-free tier is paid)', async () => {
    currentTier = 'tier_25_200';
    expect(await maxProjectsForAccount(nextAccount())).toBe(MAX_PROJECTS_PER_ACCOUNT);
  });

  test('enterprise → uncapped (unlimited projects)', async () => {
    currentTier = 'enterprise';
    expect(await maxProjectsForAccount(nextAccount())).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('billing disabled → uncapped regardless of tier', async () => {
    billingEnabled = false;
    currentTier = 'free';
    expect(await maxProjectsForAccount(nextAccount())).toBe(Number.MAX_SAFE_INTEGER);
  });
});
