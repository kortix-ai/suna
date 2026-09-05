import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Custom compute pricing: `ResolvedBilling.compute.rateMultiplier` scales what
// a metered window costs. 1.0 is list price — what every account bills at
// today, so the default path must be byte-identical to the old arithmetic — and
// 0 is deliberate (free compute for internal/partner accounts).
//
// The resolver is MOCKED here: this test is about the multiplication and the
// wiring around it (which number is claimed, debited, and described), not about
// how an override resolves — unit-resolve-billing.test.ts owns that.

const RATE = { cpuPerCoreSecond: 0.0000168, memoryPerGbSecond: 0.0000054, diskPerGbSecond: 0.000000036 };

// `mock.module` replaces the module WHOLESALE, so every export the import
// graph below reaches for has to be present — config.ts boots env validation at
// module scope, which a unit test must not do.
mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  KNOWN_PROVIDERS: ['daytona', 'platinum', 'e2b'] as const,
  KORTIX_MARKUP: 1.2,
  PLATFORM_FEE_MARKUP: 0.1,
  parseAllowedProviders: () => ['daytona'],
  getToolCost: () => 0,
  config: {
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
    INTERNAL_KORTIX_ENV: 'dev',
    ALLOWED_SANDBOX_PROVIDERS: ['daytona'],
    getDefaultProvider: () => 'daytona',
  },
}));
mock.module('../shared/db', () => ({ db: {} }));
mock.module('../platform/providers/compute-rates', () => ({
  getProviderComputeRateCard: () => RATE,
}));

let multiplier = 1;
mock.module('../billing/services/billing-cache', () => ({
  resolveAccountBilling: async () => ({ compute: { rateMultiplier: multiplier } }),
  invalidateAccountBilling: () => {},
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => ({ billingModel: 'per_seat' }),
  upsertCreditAccount: async () => {},
  updateCreditAccount: async () => {},
}));

const debits: Array<{ amount: number; description: string }> = [];
// Compute SETTLES: the seconds are already consumed, so the debit must record
// even against a drained wallet. Admission (deductCredits) is a different
// question and a different module.
mock.module('../billing/services/settle-credits', () => ({
  settleCredits: async (_accountId: string, amount: number, description: string) => {
    debits.push({ amount, description });
    return { success: true, cost: amount, newBalance: 0, overdraft: false };
  },
}));

const SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };
const WINDOW_SECONDS = 3600;
const STARTED = new Date('2026-08-11T00:00:00.000Z');
const ENDED = new Date(STARTED.getTime() + WINDOW_SECONDS * 1000);

let openRow: Record<string, unknown> | null = null;
const claims: Array<{ addCostUsd: number }> = [];
mock.module('../billing/repositories/compute-sessions', () => ({
  getOpenComputeSession: async () => openRow,
  claimComputeWindow: async (input: { addCostUsd: number }) => {
    claims.push({ addCostUsd: input.addCostUsd });
    openRow = null;
    return true;
  },
  releaseComputeWindow: async () => true,
  insertComputeSession: async () => null,
  getLatestComputeSession: async () => null,
  findStaleActiveSessions: async () => [],
}));

const { calculateComputeCost, pauseComputeSession } = await import(
  '../billing/services/compute-metering'
);

/** The list-price cost of the window every case below settles. */
const LIST_PRICE =
  (SPEC.cpuCores * RATE.cpuPerCoreSecond +
    SPEC.memoryGb * RATE.memoryPerGbSecond +
    SPEC.diskGb * RATE.diskPerGbSecond) *
  WINDOW_SECONDS;

function openWindow() {
  openRow = {
    id: 'cs_1',
    accountId: 'acct_1',
    sandboxId: 'sbx_1',
    provider: 'daytona',
    ...SPEC,
    state: 'active',
    startedAt: STARTED.toISOString(),
    lastBilledAt: STARTED.toISOString(),
    endedAt: null,
    costUsd: '0',
    // Keeps the liveness clamp from cutting the window short — this test is
    // about the multiplier, and compute-liveness owns its own coverage.
    metadata: { lastAliveAt: ENDED.toISOString() },
  };
}

beforeEach(() => {
  debits.length = 0;
  claims.length = 0;
  multiplier = 1;
  openWindow();
});

describe('calculateComputeCost', () => {
  test('no multiplier bills list price (the default is a no-op)', () => {
    expect(calculateComputeCost(SPEC, WINDOW_SECONDS)).toBeCloseTo(LIST_PRICE, 12);
    expect(calculateComputeCost(SPEC, WINDOW_SECONDS, 'daytona', 1)).toBeCloseTo(LIST_PRICE, 12);
  });

  test('the multiplier scales the whole window, in both directions', () => {
    expect(calculateComputeCost(SPEC, WINDOW_SECONDS, 'daytona', 2)).toBeCloseTo(LIST_PRICE * 2, 12);
    expect(calculateComputeCost(SPEC, WINDOW_SECONDS, 'daytona', 0.25)).toBeCloseTo(
      LIST_PRICE * 0.25,
      12,
    );
  });

  test('0 is free compute, not "no override"', () => {
    expect(calculateComputeCost(SPEC, WINDOW_SECONDS, 'daytona', 0)).toBe(0);
  });

  test('an out-of-range multiplier is clamped to [0, 10] here too', () => {
    expect(calculateComputeCost(SPEC, WINDOW_SECONDS, 'daytona', 1000)).toBeCloseTo(
      LIST_PRICE * 10,
      12,
    );
    expect(calculateComputeCost(SPEC, WINDOW_SECONDS, 'daytona', -4)).toBe(0);
  });

  test('a zero-length window is free whatever the multiplier says', () => {
    expect(calculateComputeCost(SPEC, 0, 'daytona', 5)).toBe(0);
    expect(calculateComputeCost(SPEC, -10, 'daytona', 5)).toBe(0);
  });
});

describe('settling a window applies the account multiplier', () => {
  test('default 1.0 → the debit and the claim are exactly list price', async () => {
    await pauseComputeSession('sbx_1', ENDED);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.addCostUsd).toBeCloseTo(LIST_PRICE, 12);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBeCloseTo(LIST_PRICE, 12);
  });

  test('a 2× account is charged twice list price', async () => {
    multiplier = 2;
    await pauseComputeSession('sbx_1', ENDED);
    expect(debits[0]!.amount).toBeCloseTo(LIST_PRICE * 2, 12);
    expect(claims[0]!.addCostUsd).toBeCloseTo(LIST_PRICE * 2, 12);
  });

  test('a 0× account settles the window and debits nothing', async () => {
    multiplier = 0;
    await pauseComputeSession('sbx_1', ENDED);
    // The window still closes — free compute is priced at zero, not unmetered.
    expect(claims).toHaveLength(1);
    expect(claims[0]!.addCostUsd).toBe(0);
    expect(debits).toHaveLength(0);
  });

  test('the ledger description names the rate only when it is not list price', async () => {
    await pauseComputeSession('sbx_1', ENDED);
    expect(debits[0]!.description).not.toContain('rate');

    openWindow();
    multiplier = 3;
    await pauseComputeSession('sbx_1', ENDED);
    expect(debits[1]!.description).toContain('3× rate');
  });

  test('a resolver failure bills at list price instead of dropping the window', async () => {
    mock.module('../billing/services/billing-cache', () => ({
      resolveAccountBilling: async () => {
        throw new Error('billing cache exploded');
      },
      invalidateAccountBilling: () => {},
    }));
    await pauseComputeSession('sbx_1', ENDED);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBeCloseTo(LIST_PRICE, 12);
  });
});
