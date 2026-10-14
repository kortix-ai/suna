import { describe, expect, test } from 'bun:test';
import {
  amountFromSlider,
  CREDITS_PLAN_MAX_USD,
  CREDITS_PLAN_MIN_USD,
  CREDITS_PLAN_PRESETS,
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  estimateDefaultCompute,
  estimatePlanCompute,
  isValidMonthlyUsd,
  monthlyCreditsForUsd,
  presetForMonthlyUsd,
  sliderFromMonthlyUsd,
} from './compute-pricing';

describe('compute pricing estimates', () => {
  test('uses the billed default-machine hourly rate', () => {
    expect(DEFAULT_COMPUTE_HOURLY_PRICE_USD).toBeCloseTo(0.201312, 8);
  });

  test('2,500 credits equals $25 and 124.2 hours of default compute', () => {
    const estimate = estimateDefaultCompute(2500);
    expect(estimate.creditValueUsd).toBe(25);
    expect(estimate.runtimeHours).toBeCloseTo(124.1853, 4);
  });

  test('negative credits return zero value and runtime', () => {
    expect(estimateDefaultCompute(-100)).toEqual({
      creditValueUsd: 0,
      runtimeHours: 0,
    });
  });

  test('plan estimates scale credits and runtime by the monthly amount, flat rate', () => {
    const starter = estimatePlanCompute(20);
    expect(starter.monthlyCredits).toBe(2000);
    expect(starter.runtimeHours).toBeCloseTo(99.3483, 3);

    const scale = estimatePlanCompute(500);
    expect(scale.monthlyCredits).toBe(50_000);
    expect(scale.runtimeHours / starter.runtimeHours).toBeCloseTo(25, 6);
  });
});

describe('credits plan amounts', () => {
  test('presets are 2,000 / 10,000 / 50,000 credits at 1 credit = $0.01', () => {
    expect(CREDITS_PLAN_PRESETS.map((p) => monthlyCreditsForUsd(p.monthlyUsd))).toEqual([
      2000, 10_000, 50_000,
    ]);
  });

  test('presetForMonthlyUsd names the three presets and nothing else', () => {
    expect(presetForMonthlyUsd(20)).toBe('starter');
    expect(presetForMonthlyUsd(100)).toBe('pro');
    expect(presetForMonthlyUsd(500)).toBe('scale');
    expect(presetForMonthlyUsd(250)).toBeNull();
    expect(presetForMonthlyUsd(null)).toBeNull();
  });

  test('valid amounts are whole dollars from $20 to $10,000', () => {
    expect(isValidMonthlyUsd(CREDITS_PLAN_MIN_USD)).toBe(true);
    expect(isValidMonthlyUsd(CREDITS_PLAN_MAX_USD)).toBe(true);
    expect(isValidMonthlyUsd(19)).toBe(false);
    expect(isValidMonthlyUsd(10_001)).toBe(false);
    expect(isValidMonthlyUsd(25.5)).toBe(false);
    expect(isValidMonthlyUsd(null)).toBe(false);
    expect(isValidMonthlyUsd(Number.NaN)).toBe(false);
  });

  test('slider maps the ends exactly and always lands on a valid amount', () => {
    expect(amountFromSlider(0)).toBe(CREDITS_PLAN_MIN_USD);
    expect(amountFromSlider(100)).toBe(CREDITS_PLAN_MAX_USD);
    expect(sliderFromMonthlyUsd(CREDITS_PLAN_MIN_USD)).toBe(0);
    expect(sliderFromMonthlyUsd(CREDITS_PLAN_MAX_USD)).toBeCloseTo(100, 8);
    for (let position = 0; position <= 100; position += 1) {
      expect(isValidMonthlyUsd(amountFromSlider(position))).toBe(true);
    }
  });

  test('slider amounts are monotonic', () => {
    let previous = 0;
    for (let position = 0; position <= 100; position += 1) {
      const amount = amountFromSlider(position);
      expect(amount).toBeGreaterThanOrEqual(previous);
      previous = amount;
    }
  });
});
