import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createMockCreditAccount,
  mockRegistry,
  registerWalletMock,
  fakeWallet,
  registerGlobalMocks,
  resetMockRegistry,
} from './mocks';

registerGlobalMocks();
registerWalletMock();

type CreditAccountMock = ReturnType<typeof createMockCreditAccount>;
type CreditAccountPatch = Record<string, string | number | boolean | null | undefined>;
const walletGrants = fakeWallet.calls.grant;
const walletResets = fakeWallet.calls.reset;
let upsertCreditAccountCalls: { accountId: string; data: CreditAccountPatch }[] = [];
let updateCreditAccountCalls: { accountId: string; data: CreditAccountPatch }[] = [];
let freeAccountsDueResult: CreditAccountMock[] = [];

beforeEach(() => {
  upsertCreditAccountCalls = [];
  updateCreditAccountCalls = [];
  freeAccountsDueResult = [];
  resetMockRegistry();

  mockRegistry.getCreditAccount = async () =>
    createMockCreditAccount({ tier: 'free', balance: '5.0000' });
  mockRegistry.upsertCreditAccount = async (accountId: string, data: CreditAccountPatch) => {
    upsertCreditAccountCalls.push({ accountId, data });
  };
  mockRegistry.updateCreditAccount = async (accountId: string, data: CreditAccountPatch) => {
    updateCreditAccountCalls.push({ accountId, data });
  };
  mockRegistry.getFreeAccountsDueForRotation = async () => freeAccountsDueResult;
});

const { initializeFreeTierAccount, ensureFreeTierAccountReady } = await import(
  '../../billing/services/free-tier'
);
const { processFreeTierCreditRotation } = await import('../../billing/services/free-tier-rotation');

describe('free tier account setup', () => {
  test('initializes a free account with one idempotent $2 expiring grant', async () => {
    await initializeFreeTierAccount('acc_free_1');

    expect(upsertCreditAccountCalls).toHaveLength(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('acc_free_1');
    expect(upsertCreditAccountCalls[0].data.tier).toBe('free');
    expect(upsertCreditAccountCalls[0].data.billingCycleAnchor).toBeDefined();
    expect(upsertCreditAccountCalls[0].data.nextCreditGrant).toBeDefined();

    expect(walletGrants).toHaveLength(1);
    expect(walletGrants[0]).toEqual({
      accountId: 'acc_free_1',
      amount: 2,
      kind: 'free_tier_grant',
      description: 'Free tier welcome credits',
      expiring: true,
      key: { event: 'free_tier_signup:acc_free_1' },
    });
  });

  test('repairs a missing credit account before billing gates run', async () => {
    mockRegistry.getCreditAccount = async () => null;

    await ensureFreeTierAccountReady('acc_missing');

    expect(upsertCreditAccountCalls).toHaveLength(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('acc_missing');
    expect(walletGrants).toHaveLength(1);
  });

  test('repairs legacy none tier with too little balance', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'none',
        balance: '0.0000',
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
      });

    await ensureFreeTierAccountReady('acc_none_low');

    expect(upsertCreditAccountCalls).toHaveLength(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('acc_none_low');
    expect(walletGrants).toHaveLength(1);
  });

  // The guard exists for a paying row whose tier still reads 'none': without it,
  // the repair below would re-initialize a customer as free.
  test.each([
    ['active', false],
    ['past_due', false],
    ['canceled', true],
    ['unpaid', true],
  ])('a drained none-tier row with a "%s" subscription is re-initialized as free: %p', async (status, reinitialized) => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'none',
        balance: '0.0000',
        stripeSubscriptionId: 'sub_paid',
        stripeSubscriptionStatus: status,
      });

    await ensureFreeTierAccountReady('acc_paid');

    expect(upsertCreditAccountCalls.length > 0).toBe(reinitialized);
    expect(walletGrants.length > 0).toBe(reinitialized);
  });

});

describe('free tier monthly credit rotation', () => {
  const now = new Date('2026-07-25T10:00:00.000Z');

  test('a due free account is reset to exactly $2 under a monthly UTC key', async () => {
    freeAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_300_left',
        tier: 'free',
        balance: '3.0000',
        expiringCredits: '3.0000',
        nonExpiringCredits: '0.0000',
        nextCreditGrant: '2026-07-25T00:00:00.000Z',
      }),
    ];

    const result = await processFreeTierCreditRotation(now);

    expect(result).toEqual({ processed: 1, skipped: 0, errors: [] });
    expect(walletResets).toHaveLength(1);
    expect(walletResets[0].accountId).toBe('acc_300_left');
    expect(walletResets[0].amount).toBe(2);
    expect(walletResets[0].description).toBe('Free tier monthly credit reset: 2 credits');
    expect(walletResets[0].key).toEqual({ event: 'free_tier_rotation_acc_300_left_2026-07' });
  });

  test('updates the next monthly grant anchor after resetting', async () => {
    freeAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_due',
        tier: 'free',
        nextCreditGrant: '2026-07-25T00:00:00.000Z',
      }),
    ];

    await processFreeTierCreditRotation(now);

    expect(updateCreditAccountCalls).toHaveLength(1);
    expect(updateCreditAccountCalls[0].accountId).toBe('acc_due');
    expect(updateCreditAccountCalls[0].data.lastGrantDate).toBe(now.toISOString());
    expect(
      new Date(String(updateCreditAccountCalls[0].data.nextCreditGrant)).getTime(),
    ).toBeGreaterThan(now.getTime());
  });

  test('continues processing due accounts when one reset fails', async () => {
    freeAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_error',
        tier: 'free',
        nextCreditGrant: '2026-07-25T00:00:00.000Z',
      }),
      createMockCreditAccount({
        accountId: 'acc_ok',
        tier: 'free',
        nextCreditGrant: '2026-07-25T00:00:00.000Z',
      }),
    ];
    fakeWallet.wallet.reset = async (input) => {
      walletResets.push(input);
      if (input.accountId === 'acc_error') throw new Error('reset failed');
    };

    const result = await processFreeTierCreditRotation(now);

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('acc_error');
    expect(walletResets.map((call) => call.accountId)).toEqual(['acc_error', 'acc_ok']);
  });

  test.each([
    ['a free account never granted before is processed', { tier: 'free', nextCreditGrant: null }, 'processed'],
    ['a free account not due yet is skipped', { tier: 'free', nextCreditGrant: '2026-08-25T00:00:00.000Z' }, 'skipped'],
    ['a per-seat account is skipped', { tier: 'per_seat', nextCreditGrant: '2026-07-25T00:00:00.000Z' }, 'skipped'],
    ['a none-tier account is skipped', { tier: 'none', nextCreditGrant: '2026-07-25T00:00:00.000Z' }, 'skipped'],
  ] as const)('%s', async (_name, row, outcome) => {
    freeAccountsDueResult = [createMockCreditAccount({ accountId: 'acc_row', ...row })];

    const result = await processFreeTierCreditRotation(now);

    expect(result.processed).toBe(outcome === 'processed' ? 1 : 0);
    expect(result.skipped).toBe(outcome === 'skipped' ? 1 : 0);
    expect(walletResets).toHaveLength(outcome === 'processed' ? 1 : 0);
  });
});
