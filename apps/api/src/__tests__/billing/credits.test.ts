import { describe, expect, test } from 'bun:test';
import { getManagedModel } from '@kortix/llm-catalog';
import { calculateTokenCost } from '../../billing/services/credits';

// Token pricing for `POST /v1/billing/deduct`. Credit movements are the
// wallet's (billing/wallet), pinned against real PostgreSQL in
// tests/migration/wallet-ledger.test.ts.

describe('calculateTokenCost', () => {
  const pricing = getManagedModel('glm-5.3-flash')!.pricing!;

  test.each([
    ['one million tokens each way', 1_000_000, 1_000_000, (pricing.inputPerMillion + pricing.outputPerMillion) * 1.2],
    ['no tokens', 0, 0, 0],
  ])('a managed model is billed at its catalog price with a 1.2x markup: %s', (_name, prompt, completion, expected) => {
    expect(calculateTokenCost(prompt, completion, 'glm-5.3-flash')).toBeCloseTo(expected, 6);
  });

  test('rejects an unknown model instead of treating it as free', () => {
    expect(() => calculateTokenCost(1_000_000, 1_000_000, 'some-unknown-model')).toThrow('No billing price');
  });
});
