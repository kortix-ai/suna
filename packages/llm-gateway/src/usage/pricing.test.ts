import { describe, expect, test } from 'bun:test';
import { calculateCost } from './pricing';

/**
 * BILLING-CORRECTNESS: calculateCost is the $ formula billed on every gateway
 * request and previously had zero real unit tests (the only *.test.ts
 * reference to it replaced it with a mock — e2e-router.test.ts — never
 * exercising the real implementation). This covers every branch: the plain
 * pricing-table path, the cached-token discount (with and without an
 * explicit rate), the cache-WRITE premium (the other half of this audit's
 * fix — Anthropic bills cache-creation tokens at a real premium, not the
 * plain input rate), upstreamCostHint precedence over the table, markup=0
 * (free tier) and markup>1 (platform fee/managed markup), and malformed
 * usage shapes (cachedTokens/cacheWriteTokens larger than promptTokens).
 */

const BASE_PRICING = { inputPerMillion: 3, outputPerMillion: 15 };

describe('calculateCost — plain pricing-table path', () => {
  test('prices prompt + completion tokens at the table rate with markup 1', () => {
    const { upstreamCost, finalCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 },
      1,
      undefined,
      BASE_PRICING,
    );
    expect(upstreamCost).toBeCloseTo(3 + 15, 10);
    expect(finalCost).toBeCloseTo(18, 10);
  });

  test('markup 0 (free tier) zeroes the final cost but keeps the real upstream cost', () => {
    const { upstreamCost, finalCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 },
      0,
      undefined,
      BASE_PRICING,
    );
    expect(upstreamCost).toBeCloseTo(3, 10);
    expect(finalCost).toBe(0);
  });

  test('markup > 1 (platform-fee / managed markup) scales only the final cost', () => {
    const { upstreamCost, finalCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 },
      1.2,
      undefined,
      BASE_PRICING,
    );
    expect(upstreamCost).toBeCloseTo(3, 10);
    expect(finalCost).toBeCloseTo(3.6, 10);
  });

  test('no pricing table and no cost hint → zero (never invents a price)', () => {
    const { upstreamCost, finalCost } = calculateCost(
      'unknown-model',
      { promptTokens: 1_000, completionTokens: 1_000, cachedTokens: 0 },
      1,
    );
    expect(upstreamCost).toBe(0);
    expect(finalCost).toBe(0);
  });
});

describe('calculateCost — cache READ discount', () => {
  test('uses an explicit cachedInputPerMillion when the table provides one', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 },
      1,
      undefined,
      { ...BASE_PRICING, cachedInputPerMillion: 0.3 },
    );
    // Entirely cached: 1M cached tokens at 0.3/M, no plain-rate remainder.
    expect(upstreamCost).toBeCloseTo(0.3, 10);
  });

  test('falls back to 10% of the input rate when no explicit cache-read rate is given', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 },
      1,
      undefined,
      BASE_PRICING,
    );
    expect(upstreamCost).toBeCloseTo(3 * 0.1, 10);
  });

  test('mixed cached + plain input tokens are priced separately', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 400_000 },
      1,
      undefined,
      { ...BASE_PRICING, cachedInputPerMillion: 0.3 },
    );
    const expected = (600_000 / 1_000_000) * 3 + (400_000 / 1_000_000) * 0.3;
    expect(upstreamCost).toBeCloseTo(expected, 10);
  });
});

describe('calculateCost — cache WRITE premium (the fixed leak)', () => {
  test('prices cache-creation tokens at an explicit cacheWritePerMillion rate, not the plain input rate', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 1_000_000,
      },
      1,
      undefined,
      { ...BASE_PRICING, cacheWritePerMillion: 3.75 },
    );
    // Entirely cache-write: 1M tokens at 3.75/M (Anthropic's real 1.25x
    // 5-minute-TTL premium for a $3/M base input model), no plain remainder.
    expect(upstreamCost).toBeCloseTo(3.75, 10);
  });

  test('falls back to 1.25x the base input rate (Anthropic\'s published 5-minute cache-write multiplier) when no explicit rate is given', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 1_000_000,
      },
      1,
      undefined,
      BASE_PRICING,
    );
    expect(upstreamCost).toBeCloseTo(3 * 1.25, 10);
  });

  test('cache-write and cache-read and plain input all price independently in the same request', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      {
        promptTokens: 1_000_000,
        completionTokens: 200_000,
        cachedTokens: 300_000,
        cacheWriteTokens: 200_000,
      },
      1,
      undefined,
      { ...BASE_PRICING, cachedInputPerMillion: 0.3, cacheWritePerMillion: 3.75 },
    );
    const plain = 1_000_000 - 300_000 - 200_000; // 500,000
    const expected =
      (plain / 1_000_000) * 3 +
      (300_000 / 1_000_000) * 0.3 +
      (200_000 / 1_000_000) * 3.75 +
      (200_000 / 1_000_000) * 15;
    expect(upstreamCost).toBeCloseTo(expected, 10);
  });

  test('omitting cacheWriteTokens entirely (older/non-Anthropic call sites) behaves exactly as before', () => {
    const { upstreamCost } = calculateCost(
      'gpt-5.5',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 },
      1,
      undefined,
      BASE_PRICING,
    );
    expect(upstreamCost).toBeCloseTo(3, 10);
  });
});

describe('calculateCost — upstreamCostHint precedence', () => {
  test('a pricing table takes precedence over an upstreamCostHint when both are present', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 },
      1,
      999, // would be wildly wrong if used
      BASE_PRICING,
    );
    expect(upstreamCost).toBeCloseTo(3, 10);
  });

  test('a positive upstreamCostHint is used verbatim when there is no pricing table', () => {
    const { upstreamCost, finalCost } = calculateCost(
      'openrouter/some-model',
      { promptTokens: 500, completionTokens: 500, cachedTokens: 0 },
      1.1,
      0.0042,
    );
    expect(upstreamCost).toBe(0.0042);
    expect(finalCost).toBeCloseTo(0.0042 * 1.1, 10);
  });

  test('an upstreamCostHint of exactly 0 is NOT treated as "present" — falls through to zero, not an error', () => {
    const { upstreamCost } = calculateCost(
      'openrouter/some-model',
      { promptTokens: 500, completionTokens: 500, cachedTokens: 0 },
      1,
      0,
    );
    expect(upstreamCost).toBe(0);
  });

  test('a negative upstreamCostHint is ignored (never produces a negative bill)', () => {
    const { upstreamCost } = calculateCost(
      'openrouter/some-model',
      { promptTokens: 500, completionTokens: 500, cachedTokens: 0 },
      1,
      -5,
    );
    expect(upstreamCost).toBe(0);
  });

  test('an undefined upstreamCostHint with no table prices to zero', () => {
    const { upstreamCost } = calculateCost(
      'openrouter/some-model',
      { promptTokens: 500, completionTokens: 500, cachedTokens: 0 },
      1,
      undefined,
    );
    expect(upstreamCost).toBe(0);
  });
});

describe('calculateCost — malformed usage shapes never produce a negative or NaN bill', () => {
  test('cachedTokens greater than promptTokens (a short/malformed upstream usage object) does not go negative', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 100, completionTokens: 0, cachedTokens: 500 },
      1,
      undefined,
      { ...BASE_PRICING, cachedInputPerMillion: 0.3 },
    );
    expect(upstreamCost).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(upstreamCost)).toBe(false);
    // The plain-input remainder clamps to 0, not a negative number — only the
    // (fully-charged) cache-read portion contributes.
    expect(upstreamCost).toBeCloseTo((500 / 1_000_000) * 0.3, 10);
  });

  test('cachedTokens + cacheWriteTokens together exceeding promptTokens still clamps the plain remainder to zero', () => {
    const { upstreamCost } = calculateCost(
      'claude-sonnet-4.6',
      { promptTokens: 100, completionTokens: 0, cachedTokens: 60, cacheWriteTokens: 60 },
      1,
      undefined,
      { ...BASE_PRICING, cachedInputPerMillion: 0.3, cacheWritePerMillion: 3.75 },
    );
    expect(Number.isNaN(upstreamCost)).toBe(false);
    expect(upstreamCost).toBeGreaterThanOrEqual(0);
    const expected = (60 / 1_000_000) * 0.3 + (60 / 1_000_000) * 3.75;
    expect(upstreamCost).toBeCloseTo(expected, 10);
  });
});
