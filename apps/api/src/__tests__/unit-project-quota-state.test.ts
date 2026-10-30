/**
 * Unit test for `projectQuotaState` — the account's project-cap state the
 * `GET /v1/projects/quota` pre-check serves, and the single computation
 * `projectQuotaDenial` (the 403 body of the create routes) now derives from.
 * The pre-check and the denial must never disagree: the /new page renders the
 * state on load, so a cap the UI misses on load is the exact defect
 * (KRTX-2495) this endpoint exists to close.
 *
 * Mocked the same way `unit-project-limit-policy.test.ts` is (config +
 * credit-accounts for the tier) plus a stubbed `shared/db` for the
 * active-project count. The SQL predicate itself (active-only counting) is
 * pre-existing behavior of `projectQuotaDenial`, unchanged here.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mutable knobs the mocks read.
let billingEnabled = true;
let currentTier: string | null = 'free';
let activeProjectCount = 0;
let countQueried = 0;

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
  getCreditAccount: async () => (currentTier === null ? null : { tier: currentTier }),
}));

// The one query `projectQuotaState` runs: count the account's projects.
mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          countQueried += 1;
          return Promise.resolve([{ count: activeProjectCount }]);
        },
      }),
    }),
  },
}));

const { projectQuotaState, projectQuotaDenial } = await import(
  '../projects/lib/project-quota'
);
const { FREE_TIER_PROJECT_LIMIT } = await import('../shared/account-limits');
const { MAX_PROJECTS_PER_ACCOUNT } = await import('../billing/services/tiers');

let n = 0;
const nextAccount = () => `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`;

describe('projectQuotaState — the cap state the /new pre-check serves', () => {
  beforeEach(() => {
    billingEnabled = true;
    currentTier = 'free';
    activeProjectCount = 0;
    countQueried = 0;
  });

  test('free account under the cap → not capped, count reported, no message', async () => {
    activeProjectCount = 0;
    const state = await projectQuotaState(nextAccount());
    expect(state).toEqual({ capped: false, limit: FREE_TIER_PROJECT_LIMIT, count: 0, message: null });
  });

  test('free account at the cap → capped with the exact denial message', async () => {
    activeProjectCount = FREE_TIER_PROJECT_LIMIT;
    const state = await projectQuotaState(nextAccount());
    expect(state.capped).toBe(true);
    expect(state.limit).toBe(1);
    expect(state.count).toBe(1);
    expect(state.message).toBe(
      'Free accounts are limited to 1 project. Upgrade to a paid plan to create more.',
    );
  });

  test('the state message is byte-identical to the denial body the create returns', async () => {
    activeProjectCount = FREE_TIER_PROJECT_LIMIT;
    const accountId = nextAccount();
    const state = await projectQuotaState(accountId);
    const denial = await projectQuotaDenial(accountId);
    if (!denial) throw new Error('expected a denial body for a capped free account');
    expect(state.capped).toBe(true);
    expect(state.message).toBe(denial.error);
    expect(denial.code).toBe('project_limit_reached');
    expect(denial.limit).toBe(state.limit);
    expect(denial.count).toBe(state.count);
  });

  test('paid tier → uncapped only at the plan cap, count still reported', async () => {
    currentTier = 'credits';
    const state = await projectQuotaState(nextAccount());
    expect(state).toEqual({ capped: false, limit: MAX_PROJECTS_PER_ACCOUNT, count: 0, message: null });
  });

  test('billing disabled → uncapped regardless of tier, no count query', async () => {
    billingEnabled = false;
    currentTier = 'free';
    const state = await projectQuotaState(nextAccount());
    expect(state.capped).toBe(false);
    expect(state.message).toBeNull();
    expect(countQueried).toBe(0);
  });

  test('an account that freed its slot is not capped again', async () => {
    activeProjectCount = FREE_TIER_PROJECT_LIMIT - 1;
    const state = await projectQuotaState(nextAccount());
    expect(state.capped).toBe(false);
    expect(state.count).toBe(0);
    expect(state.message).toBeNull();
  });

  test('projectQuotaDenial stays null under the cap', async () => {
    activeProjectCount = 0;
    expect(await projectQuotaDenial(nextAccount())).toBeNull();
  });
});
