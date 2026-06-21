import { describe, expect, test } from 'bun:test';
import { calculateCost } from '../services/pricing';

const usage = (p: number, c: number, cached = 0) => ({
  promptTokens: p,
  completionTokens: c,
  cachedTokens: cached,
});

describe('calculateCost — upstream hint', () => {
  test('uses upstream cost when provided', () => {
    const result = calculateCost('anything', usage(1000, 1000), 1, 0.005);
    expect(result.upstreamCost).toBe(0.005);
    expect(result.finalCost).toBe(0.005);
  });

  test('applies markup to upstream hint', () => {
    const result = calculateCost('anything', usage(1000, 1000), 1.2, 0.005);
    expect(result.upstreamCost).toBe(0.005);
    expect(result.finalCost).toBeCloseTo(0.006, 6);
  });

  test('ignores zero-or-negative hint without local fallback pricing', () => {
    const result = calculateCost('anthropic/claude-sonnet-4.6', usage(1_000_000, 0), 1, 0);
    expect(result.upstreamCost).toBe(0);
    expect(result.finalCost).toBe(0);
  });
});

describe('calculateCost — explicit pricing override', () => {
  test('uses provided live pricing when upstream hint is absent', () => {
    const result = calculateCost(
      'anthropic/claude-sonnet-4.6',
      usage(1_000_000, 1_000_000),
      1,
      undefined,
      {
        inputPerMillion: 3,
        outputPerMillion: 15,
      },
    );
    expect(result.upstreamCost).toBeCloseTo(3 + 15, 6);
  });

  test('provided live pricing is authoritative over upstream hint', () => {
    const result = calculateCost('anthropic/claude-sonnet-4.6', usage(1_000_000, 0), 1, 0.005, {
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
    expect(result.upstreamCost).toBeCloseTo(3, 6);
  });

  test('returns zero without live pricing or upstream hint', () => {
    const result = calculateCost('totally-unknown/model-7b', usage(1_000_000, 1_000_000), 1);
    expect(result.upstreamCost).toBe(0);
    expect(result.finalCost).toBe(0);
  });

  test('cached tokens billed at 10% of input rate by default', () => {
    const result = calculateCost(
      'anthropic/claude-sonnet-4.6',
      usage(1_000_000, 0, 1_000_000),
      1,
      undefined,
      {
        inputPerMillion: 3,
        outputPerMillion: 15,
      },
    );
    expect(result.upstreamCost).toBeCloseTo(0.3, 6);
  });

  test('partial cached tokens split correctly', () => {
    const result = calculateCost(
      'anthropic/claude-sonnet-4.6',
      usage(1_000_000, 0, 500_000),
      1,
      undefined,
      {
        inputPerMillion: 3,
        outputPerMillion: 15,
      },
    );
    const expectedFresh = (500_000 / 1_000_000) * 3;
    const expectedCached = (500_000 / 1_000_000) * 0.3;
    expect(result.upstreamCost).toBeCloseTo(expectedFresh + expectedCached, 6);
  });
});

describe('calculateCost — markup', () => {
  test('markup of 1.0 leaves cost unchanged', () => {
    const result = calculateCost('anthropic/claude-sonnet-4.6', usage(1_000_000, 0), 1, undefined, {
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
    expect(result.finalCost).toBeCloseTo(result.upstreamCost, 6);
  });

  test('markup of 1.2 adds 20%', () => {
    const result = calculateCost(
      'anthropic/claude-sonnet-4.6',
      usage(1_000_000, 0),
      1.2,
      undefined,
      {
        inputPerMillion: 3,
        outputPerMillion: 15,
      },
    );
    expect(result.finalCost).toBeCloseTo(result.upstreamCost * 1.2, 6);
  });

  test('zero usage yields zero cost', () => {
    const result = calculateCost('anthropic/claude-sonnet-4.6', usage(0, 0), 1.5);
    expect(result.upstreamCost).toBe(0);
    expect(result.finalCost).toBe(0);
  });
});
