import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createMockCreditAccount,
  mockRegistry,
  registerCreditsMock,
  registerGlobalMocks,
  resetMockRegistry,
} from './mocks';

registerGlobalMocks();
registerCreditsMock();

type CreditAccountMock = ReturnType<typeof createMockCreditAccount>;
type CreditAccountPatch = Record<string, string | number | boolean | null | undefined>;
type GrantCreditsCall = [string, number, string, string, boolean?, string?];
type ResetExpiringCreditsCall = [string, number, string, string?];

let grantCreditsCalls: GrantCreditsCall[] = [];
let resetExpiringCreditsCalls: ResetExpiringCreditsCall[] = [];
let upsertCreditAccountCalls: { accountId: string; data: CreditAccountPatch }[] = [];
let updateCreditAccountCalls: { accountId: string; data: CreditAccountPatch }[] = [];
let freeAccountsDueResult: CreditAccountMock[] = [];

beforeEach(() => {
  grantCreditsCalls = [];
  resetExpiringCreditsCalls = [];
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
  mockRegistry.grantCredits = async (...args) => {
    const [accountId, amount, type, description, isExpiring, stripeEventId] = args;
    grantCreditsCalls.push([accountId, amount, type, description, isExpiring, stripeEventId]);
  };
  mockRegistry.resetExpiringCredits = async (...args) => {
    const [accountId, amount, description, idempotencyKey] = args;
    resetExpiringCreditsCalls.push([accountId, amount, description, idempotencyKey]);
  };
});

const { initializeFreeTierAccount, ensureFreeTierAccountReady } = await import(
  '../../billing/services/free-tier'
);
const { isFreeTierAccountDueForRotation, processFreeTierCreditRotation } = await import(
  '../../billing/services/free-tier-rotation'
);

describe('free tier account setup', () => {
  test('initializes a free account with one idempotent $2 expiring grant', async () => {
    await initializeFreeTierAccount('acc_free_1');

    expect(upsertCreditAccountCalls).toHaveLength(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('acc_free_1');
    expect(upsertCreditAccountCalls[0].data.tier).toBe('free');
    expect(upsertCreditAccountCalls[0].data.billingCycleAnchor).toBeDefined();
    expect(upsertCreditAccountCalls[0].data.nextCreditGrant).toBeDefined();

    expect(grantCreditsCalls).toHaveLength(1);
    expect(grantCreditsCalls[0]).toEqual([
      'acc_free_1',
      2,
      'free_tier_grant',
      'Free tier welcome credits',
      true,
      'free_tier_signup:acc_free_1',
    ]);
  });

  test('repairs a missing credit account before billing gates run', async () => {
    mockRegistry.getCreditAccount = async () => null;

    await ensureFreeTierAccountReady('acc_missing');

    expect(upsertCreditAccountCalls).toHaveLength(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('acc_missing');
    expect(grantCreditsCalls).toHaveLength(1);
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
    expect(grantCreditsCalls).toHaveLength(1);
  });

  test('does not downgrade or grant free credits to active paid accounts', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        tier: 'per_seat',
        balance: '20.0000',
        billingModel: 'per_seat',
        stripeSubscriptionId: 'sub_paid',
        stripeSubscriptionStatus: 'active',
      });

    await ensureFreeTierAccountReady('acc_paid');

    expect(upsertCreditAccountCalls).toHaveLength(0);
    expect(grantCreditsCalls).toHaveLength(0);
  });
});

describe('free tier monthly credit rotation', () => {
  const now = new Date('2026-07-25T10:00:00.000Z');

  test('resets unused 300 display credits to exactly 200 fresh credits', async () => {
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
    expect(resetExpiringCreditsCalls).toHaveLength(1);
    expect(resetExpiringCreditsCalls[0][0]).toBe('acc_300_left');
    expect(resetExpiringCreditsCalls[0][1]).toBe(2);
    expect(resetExpiringCreditsCalls[0][2]).toBe('Free tier monthly credit reset: 2 credits');
    expect(resetExpiringCreditsCalls[0][3]).toBe('free_tier_rotation_acc_300_left_2026-07');
  });

  test('resets unused 20 display credits to exactly 200 fresh credits', async () => {
    freeAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_20_left',
        tier: 'free',
        balance: '0.2000',
        expiringCredits: '0.2000',
        nonExpiringCredits: '0.0000',
        nextCreditGrant: '2026-07-25T00:00:00.000Z',
      }),
    ];

    await processFreeTierCreditRotation(now);

    expect(resetExpiringCreditsCalls).toHaveLength(1);
    expect(resetExpiringCreditsCalls[0][0]).toBe('acc_20_left');
    expect(resetExpiringCreditsCalls[0][1]).toBe(2);
  });

  test('grants exactly 200 display credits even when the free wallet is empty', async () => {
    freeAccountsDueResult = [
      createMockCreditAccount({
        accountId: 'acc_empty',
        tier: 'free',
        balance: '0.0000',
        expiringCredits: '0.0000',
        nonExpiringCredits: '0.0000',
        nextCreditGrant: '2026-07-25T00:00:00.000Z',
      }),
    ];

    await processFreeTierCreditRotation(now);

    expect(resetExpiringCreditsCalls).toHaveLength(1);
    expect(resetExpiringCreditsCalls[0][1]).toBe(2);
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
    mockRegistry.resetExpiringCredits = async (...args) => {
      const [accountId, amount, description, idempotencyKey] = args;
      resetExpiringCreditsCalls.push([accountId, amount, description, idempotencyKey]);
      if (accountId === 'acc_error') throw new Error('reset failed');
    };

    const result = await processFreeTierCreditRotation(now);

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('acc_error');
    expect(resetExpiringCreditsCalls.map((call) => call[0])).toEqual(['acc_error', 'acc_ok']);
  });

  test('identifies only due free accounts for rotation', () => {
    expect(
      isFreeTierAccountDueForRotation(
        createMockCreditAccount({ tier: 'free', nextCreditGrant: '2026-07-25T00:00:00.000Z' }),
        now,
      ),
    ).toBe(true);
    expect(
      isFreeTierAccountDueForRotation(
        createMockCreditAccount({ tier: 'free', nextCreditGrant: '2026-08-25T00:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
    expect(
      isFreeTierAccountDueForRotation(
        createMockCreditAccount({ tier: 'per_seat', nextCreditGrant: '2026-07-25T00:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
    expect(
      isFreeTierAccountDueForRotation(
        createMockCreditAccount({ tier: 'none', nextCreditGrant: '2026-07-25T00:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
  });
});
