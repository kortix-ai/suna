import { describe, expect, test } from 'bun:test';
import { BYOK_FEE_FREE_MONTHLY_USD, BYOK_FEE_PERCENT, byokFeeUsd } from '../billing/services/byok-fee';

// The BYOK platform fee, OpenRouter's model at a lower allowance
// (.agents/skills/billing/references/plans-and-access.md, "Bring your own key").
describe('byokFeeUsd', () => {
  const base = { provider: 'anthropic', upstreamCostUsd: 2, monthToDateUsd: 0, enterpriseContract: false };

  test('the first $1,000 of list-price BYOK usage in a month carries no fee', () => {
    expect(BYOK_FEE_FREE_MONTHLY_USD).toBe(1000);
    expect(byokFeeUsd({ ...base, monthToDateUsd: 999.99 })).toBe(0);
  });

  test('past the allowance a request pays 5% of its list price', () => {
    expect(BYOK_FEE_PERCENT).toBe(5);
    expect(byokFeeUsd({ ...base, monthToDateUsd: 1000 })).toBe(0.1);
    expect(byokFeeUsd({ ...base, monthToDateUsd: 5000, upstreamCostUsd: 0.0123456 })).toBe(0.000617);
  });

  test('subscriptions are never charged: ChatGPT and OpenCode Go', () => {
    for (const provider of ['openai-codex', 'opencode-go']) {
      expect(byokFeeUsd({ ...base, provider, monthToDateUsd: 5000 })).toBe(0);
    }
  });

  test('an Enterprise contract waives it', () => {
    expect(byokFeeUsd({ ...base, monthToDateUsd: 5000, enterpriseContract: true })).toBe(0);
  });

  test('a request with no list price (an unpriced model) costs nothing', () => {
    expect(byokFeeUsd({ ...base, monthToDateUsd: 5000, upstreamCostUsd: 0 })).toBe(0);
    expect(byokFeeUsd({ ...base, monthToDateUsd: 5000, upstreamCostUsd: null })).toBe(0);
  });
});
