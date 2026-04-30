import { describe, test, expect, mock } from 'bun:test';

// Stub config to prevent env validation
mock.module('../config', () => ({
  config: {
    ENV_MODE: 'local',
    INTERNAL_KORTIX_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    KORTIX_URL: 'http://localhost:3000',
  },
}));

const { calculateTokenCost } = await import('../billing/services/credits');

describe('MODEL_PRICING — coverage for new and existing models', () => {
  // ── claude-sonnet-4-6 (billing fix #89) ───────────────────────────────────
  test('claude-sonnet-4-6: billed at $3/$15, not default $2/$10', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'claude-sonnet-4-6');
    const expected = (3 + 15) * 1.2; // TOKEN_PRICE_MULTIPLIER=1.2
    expect(cost).toBeCloseTo(expected, 6);
  });

  test('claude-sonnet-4-6-20260101 (dated variant): fuzzy-matches to $3/$15', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'claude-sonnet-4-6-20260101');
    const expected = (3 + 15) * 1.2;
    expect(cost).toBeCloseTo(expected, 6);
  });

  // ── router models (billing fix #107) ─────────────────────────────────────
  test('minimax/minimax-m2.7: billed at $0.30/$1.20', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'minimax/minimax-m2.7');
    const expected = (0.30 + 1.20) * 1.2;
    expect(cost).toBeCloseTo(expected, 6);
  });

  test('moonshotai/kimi-k2.5: billed at $0.45/$2.20', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'moonshotai/kimi-k2.5');
    const expected = (0.45 + 2.20) * 1.2;
    expect(cost).toBeCloseTo(expected, 6);
  });

  test('z-ai/glm-5-turbo: billed at $1.20/$4.00', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'z-ai/glm-5-turbo');
    const expected = (1.20 + 4.00) * 1.2;
    expect(cost).toBeCloseTo(expected, 6);
  });

  test('kortix/minimax-m27 alias: billed at same rate as minimax-m2.7', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'kortix/minimax-m27');
    const expected = (0.30 + 1.20) * 1.2;
    expect(cost).toBeCloseTo(expected, 6);
  });

  test('kortix/kimi alias: billed at same rate as kimi-k2.5', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'kortix/kimi');
    const expected = (0.45 + 2.20) * 1.2;
    expect(cost).toBeCloseTo(expected, 6);
  });

  // ── unknown model logs warn + falls back to $2/$10 ────────────────────────
  test('unknown model falls back to $2/$10 default', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'unknown-vendor/unknown-model-xyz');
    const expected = (2 + 10) * 1.2;
    expect(cost).toBeCloseTo(expected, 6);
  });

  // ── existing models unchanged ──────────────────────────────────────────────
  test('claude-sonnet-4-5: $3/$15', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'claude-sonnet-4-5');
    expect(cost).toBeCloseTo((3 + 15) * 1.2, 6);
  });

  test('gpt-4o: $2.5/$10', () => {
    const cost = calculateTokenCost(1_000_000, 1_000_000, 'gpt-4o');
    expect(cost).toBeCloseTo((2.5 + 10) * 1.2, 6);
  });

  test('0 tokens = 0 cost regardless of model', () => {
    expect(calculateTokenCost(0, 0, 'claude-sonnet-4-6')).toBe(0);
    expect(calculateTokenCost(0, 0, 'minimax/minimax-m2.7')).toBe(0);
  });
});
