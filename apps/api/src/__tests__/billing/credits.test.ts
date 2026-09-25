import { describe, test, expect, beforeEach } from 'bun:test';
import { createMockCreditAccount, mockRegistry, registerGlobalMocks, resetMockRegistry } from './mocks';

// Pricing and the spendable summary. Credit movements are the wallet's
// (billing/wallet), pinned against real PostgreSQL in
// tests/migration/wallet-ledger.test.ts.
registerGlobalMocks();

beforeEach(() => {
  resetMockRegistry();
  mockRegistry.getCreditAccount = async () => createMockCreditAccount();
});

const { calculateTokenCost, getCreditSummary } = await import('../../billing/services/credits');

const { TOKEN_PRICE_MULTIPLIER } = await import('../../billing/services/tiers');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('calculateTokenCost', () => {
  test('known model (glm-5.3-flash): correct cost with 1.2x multiplier', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'glm-5.3-flash');
    const expected = (0.1 + 0.35) * TOKEN_PRICE_MULTIPLIER;
    expect(cost).toBeCloseTo(expected, 6);
  });

  test('rejects a versioned model id without exact provider pricing', () => {
    expect(() =>
      calculateTokenCost(1_000_000, 1_000_000, 'claude-sonnet-4.6-20250101'),
    ).toThrow('No billing price');
  });

  test('rejects an unknown model instead of treating it as free', () => {
    expect(() => calculateTokenCost(1_000_000, 1_000_000, 'some-unknown-model')).toThrow(
      'No billing price',
    );
  });

  test('0 tokens returns 0 cost', () => {
    const cost = calculateTokenCost(0, 0, 'glm-5.3-flash');
    expect(cost).toBe(0);
  });
});

describe('getCreditSummary', () => {
  test('canRun=true when balance >= 0.01', async () => {
    const result = await getCreditSummary('acc_test_123');
    expect(result.canRun).toBe(true);
    expect(result.total).toBe(100);
    expect(result.daily).toBe(3);
    expect(result.monthly).toBe(80);
    expect(result.extra).toBe(20);
  });

  test('canRun=false when balance < 0.01', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        balance: '0.005',
        expiringCredits: '0',
        nonExpiringCredits: '0',
        dailyCreditsBalance: '0',
      });
    const result = await getCreditSummary('acc_test_123');
    expect(result.canRun).toBe(false);
  });
});
