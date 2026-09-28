import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createMockCreditAccount,
  mockRegistry,
  registerGlobalMocks,
  registerWalletMock,
  fakeWallet,
  resetMockRegistry,
} from './mocks';

// Register global mocks + the fake wallet (records every grant and reset)
registerGlobalMocks();
registerWalletMock();

// ─── Track calls ──────────────────────────────────────────────────────────────

const walletResets = fakeWallet.calls.reset;
let updateCreditAccountCalls: any[] = [];
let yearlyAccountsDueResult: any[] = [];

beforeEach(() => {
  walletResets.length = 0;
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
});

// Import AFTER mocking
const { processYearlyCreditRotation } = await import('../../billing/services/yearly-rotation');

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
    expect(walletResets.length).toBe(2);

    expect(walletResets[0].accountId).toBe('acc_yearly_1');
    expect(walletResets[0].amount).toBe(50); // tier_6_50 = $50 monthly credits

    expect(walletResets[1].accountId).toBe('acc_yearly_2');
    expect(walletResets[1].amount).toBe(200); // tier_25_200 = $200 monthly credits
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

    const idempotencyKey = walletResets[0].key.event;
    expect(idempotencyKey).toContain('yearly_rotation_acc_yearly_1_');
    expect(idempotencyKey).toContain(yearMonth);
  });

  test('continues past an account whose reset fails', async () => {
    yearlyAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_error',
        tier: 'tier_6_50',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
      }),
      createMockCreditAccount({
        accountId: 'acc_ok',
        tier: 'tier_6_50',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
      }),
    ];
    fakeWallet.wallet.reset = async (input) => {
      walletResets.push(input);
      if (input.accountId === 'acc_error') throw new Error('reset failed');
    };

    const result = await processYearlyCreditRotation();

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('acc_error');
    expect(walletResets.map((call) => call.accountId)).toEqual(['acc_error', 'acc_ok']);
    expect(updateCreditAccountCalls.map((call) => call.accountId)).toEqual(['acc_ok']);
  });

  test('a tier with no monthly credits resets nothing but still advances its anchor', async () => {
    yearlyAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_zero',
        tier: 'invalid_tier_that_has_zero_credits',
        planType: 'yearly',
        nextCreditGrant: new Date(Date.now() - 86400000).toISOString(),
      }),
    ];

    const result = await processYearlyCreditRotation();

    expect(result.processed).toBe(1);
    expect(walletResets).toEqual([]);
    expect(updateCreditAccountCalls.map((call) => call.accountId)).toEqual(['acc_zero']);
  });
});
