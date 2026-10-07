import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Settlement of a router LLM call against its reservation. Money math in
// dollars. kimi-class rates: $3.30 / M input, $16.50 / M output, markup 1.2.

const settles: Array<{ amount: number }> = [];
const grants: Array<{ amount: number }> = [];
let settleResult: { success: boolean; error?: string } = { success: true };

mock.module('./billing', () => ({
  deductLLMCredits: async () => ({ success: true, cost: 0, newBalance: 0 }),
  settleLLMCredits: async (_a: string, _m: string, _i: number, _o: number, amount: number) => {
    settles.push({ amount });
    return settleResult;
  },
}));
mock.module('../../billing/wallet', () => ({
  wallet: { grant: async (input: { amount: number }) => { grants.push(input); return {}; } },
}));
mock.module('../../shared/usage-events', () => ({ recordUsageEvent: async () => undefined }));

const { settleLlmReservation } = await import('./llm-reservation');

const modelConfig = { openrouterId: 'm', inputPer1M: 3.3, outputPer1M: 16.5, contextWindow: 1, tier: 'paid' as const };
const base = {
  accountId: 'acct-synthetic',
  modelId: 'm',
  promptTokens: 500,
  completionTokens: 32_768,
  actor: null,
  logPrefix: 'test',
  provider: 'openrouter',
  route: '/v1/test',
};

beforeEach(() => {
  settles.length = 0;
  grants.length = 0;
  settleResult = { success: true };
});

describe('settleLlmReservation', () => {
  test('the amount above the reservation is settled (overdraft allowed), not admission-debited', async () => {
    // reserved $0.0831; actual 32,768 out-tokens = $0.649 -> delta $0.5659
    await settleLlmReservation({
      ...base,
      actualCost: 0.649,
      reservation: { accountId: 'acct-synthetic', modelId: 'm', promptTokens: 500, completionTokens: 4096, cost: 0.0831, modelConfig, pricingProvider: 'openrouter' },
    });
    expect(settles).toHaveLength(1);
    expect(settles[0]!.amount).toBeCloseTo(0.5659, 10);
    expect(grants).toHaveLength(0);
  });

  test('a cost below the reservation refunds the difference', async () => {
    await settleLlmReservation({
      ...base,
      actualCost: 0.03,
      reservation: { accountId: 'acct-synthetic', modelId: 'm', promptTokens: 500, completionTokens: 4096, cost: 0.0831, modelConfig, pricingProvider: 'openrouter' },
    });
    expect(settles).toHaveLength(0);
    expect(grants[0]!.amount).toBeCloseTo(0.0531, 10);
  });

  test('no reservation: the whole cost is settled', async () => {
    await settleLlmReservation({ ...base, actualCost: 0.00792, reservation: null });
    expect(settles[0]!.amount).toBeCloseTo(0.00792, 10);
  });
});
