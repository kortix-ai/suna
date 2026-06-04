import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createMockCreditAccount,
  mockRegistry,
  registerGlobalMocks,
  registerCreditsMock,
  resetMockRegistry,
} from './mocks';

// Register global mocks + credits service mock (stubs grantCredits/resetExpiringCredits)
registerGlobalMocks();
registerCreditsMock();

// ─── Track calls ──────────────────────────────────────────────────────────────

let resetExpiringCreditsCalls: any[] = [];
let updateCreditAccountCalls: any[] = [];
let yearlyAccountsDueResult: any[] = [];

beforeEach(() => {
  resetExpiringCreditsCalls = [];
  updateCreditAccountCalls = [];
  yearlyAccountsDueResult = [];
  resetMockRegistry();

  // Credit account repo defaults
  mockRegistry.getCreditAccount = async () => createMockCreditAccount();
  mockRegistry.getCreditBalance = async () => {
    const a = createMockCreditAccount();
    return { balance: a.balance, expiringCredits: a.expiringCredits, nonExpiringCredits: a.nonExpiringCredits, dailyCreditsBalance: a.dailyCreditsBalance, tier: a.tier };
  };
  mockRegistry.updateCreditAccount = async (id: string, data: any) => {
    updateCreditAccountCalls.push({ accountId: id, data });
  };
  mockRegistry.upsertCreditAccount = async () => {};
  mockRegistry.getYearlyAccountsDueForRotation = async () => yearlyAccountsDueResult;

  // Credit service defaults
  mockRegistry.resetExpiringCredits = async (...args: any[]) => {
    resetExpiringCreditsCalls.push(args);
  };
});

// Import AFTER mocking
const {
  processYearlyCreditRotation,
  isYearlyAccountDueForRotation,
  calculateNextCreditGrant,
} = await import('../../billing/services/yearly-rotation');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('processYearlyCreditRotation', () => {
  test('finds yearly accounts due for rotation and processes each', async () => {
    yearlyAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_yearly_1',
        tier: 'tier_6_50',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'active',
      }),
      createMockCreditAccount({
        accountId: 'acc_yearly_2',
        tier: 'tier_25_200',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 3600000).toISOString(),
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'active',
      }),
    ];

    const result = await processYearlyCreditRotation();

    expect(result.processed).toBe(2);
    expect(result.errors.length).toBe(0);
    expect(resetExpiringCreditsCalls.length).toBe(2);

    expect(resetExpiringCreditsCalls[0][0]).toBe('acc_yearly_1');
    expect(resetExpiringCreditsCalls[0][1]).toBe(50); // tier_6_50 = $50 monthly credits

    expect(resetExpiringCreditsCalls[1][0]).toBe('acc_yearly_2');
    expect(resetExpiringCreditsCalls[1][1]).toBe(200); // tier_25_200 = $200 monthly credits
  });

  test('updates nextCreditGrant to 1 month later', async () => {
    yearlyAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_yearly_1',
        tier: 'tier_6_50',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'active',
      }),
    ];

    await processYearlyCreditRotation();

    expect(updateCreditAccountCalls.length).toBe(1);
    expect(updateCreditAccountCalls[0].data.nextCreditGrant).toBeDefined();
    expect(updateCreditAccountCalls[0].data.lastGrantDate).toBeDefined();

    const nextGrant = new Date(updateCreditAccountCalls[0].data.nextCreditGrant);
    const now = new Date();
    const diffDays = (nextGrant.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(25);
    expect(diffDays).toBeLessThan(35);
  });

  test('skips when no accounts are due', async () => {
    yearlyAccountsDueResult = [];

    const result = await processYearlyCreditRotation();

    expect(result.processed).toBe(0);
    expect(resetExpiringCreditsCalls.length).toBe(0);
  });

  test('creates ledger entry with idempotency key', async () => {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    yearlyAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_yearly_1',
        tier: 'tier_6_50',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'active',
      }),
    ];

    await processYearlyCreditRotation();

    const idempotencyKey = resetExpiringCreditsCalls[0][3];
    expect(idempotencyKey).toContain('yearly_rotation_acc_yearly_1_');
    expect(idempotencyKey).toContain(yearMonth);
  });

  test('continues on error for individual accounts', async () => {
    yearlyAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_error',
        tier: 'invalid_tier_that_has_zero_credits',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'active',
      }),
      createMockCreditAccount({
        accountId: 'acc_ok',
        tier: 'tier_6_50',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
        stripeSubscriptionStatus: 'active',
        paymentStatus: 'active',
      }),
    ];

    const result = await processYearlyCreditRotation();
    expect(result.processed).toBe(2);
  });
});

describe('isYearlyAccountDueForRotation', () => {
  test('true when nextCreditGrant <= now', () => {
    const account = createMockCreditAccount({
      planType: 'yearly',
      tier: 'tier_6_50',
      nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
      stripeSubscriptionStatus: 'active',
      paymentStatus: 'active',
    });

    expect(isYearlyAccountDueForRotation(account)).toBe(true);
  });

  test('false when nextCreditGrant > now', () => {
    const account = createMockCreditAccount({
      planType: 'yearly',
      tier: 'tier_6_50',
      nextCreditGrant: new Date(Date.now() + 86400000 * 15).toISOString(),
      stripeSubscriptionStatus: 'active',
      paymentStatus: 'active',
    });

    expect(isYearlyAccountDueForRotation(account)).toBe(false);
  });

  test('true when null (never rotated)', () => {
    const account = createMockCreditAccount({
      planType: 'yearly',
      tier: 'tier_6_50',
      nextCreditGrant: null,
      stripeSubscriptionStatus: 'active',
      paymentStatus: 'active',
    });

    expect(isYearlyAccountDueForRotation(account)).toBe(true);
  });

  test('false for monthly accounts', () => {
    const account = createMockCreditAccount({
      planType: 'monthly',
      tier: 'tier_6_50',
      nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
    });

    expect(isYearlyAccountDueForRotation(account)).toBe(false);
  });

  test('false for free tier', () => {
    const account = createMockCreditAccount({
      planType: 'yearly',
      tier: 'free',
      nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
    });

    expect(isYearlyAccountDueForRotation(account)).toBe(false);
  });
});

describe('calculateNextCreditGrant', () => {
  test('returns 1 month from given date', () => {
    const from = new Date('2025-03-15T12:00:00Z');
    const next = calculateNextCreditGrant(from);

    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(3);
    expect(next.getDate()).toBe(15);
  });

  test('handles month boundary (Jan 31 → Feb 28)', () => {
    const from = new Date('2025-01-31T12:00:00Z');
    const next = calculateNextCreditGrant(from);

    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(28);
  });

  test('handles December → January year rollover', () => {
    const from = new Date('2025-12-15T12:00:00Z');
    const next = calculateNextCreditGrant(from);

    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(15);
  });
});
