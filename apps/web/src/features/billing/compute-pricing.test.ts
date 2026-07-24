import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  estimateDefaultCompute,
  estimateTeamCompute,
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

  test('team estimates scale pooled credits and runtime by seat count', () => {
    const oneSeat = estimateTeamCompute(1);
    expect(oneSeat.monthlyCredits).toBe(2500);
    expect(oneSeat.runtimeHours).toBeCloseTo(124.1853, 4);

    const tenSeats = estimateTeamCompute(10);
    expect(tenSeats.monthlyCredits).toBe(25_000);
    expect(tenSeats.runtimeHours).toBeCloseTo(1241.8534, 4);

    const hundredSeats = estimateTeamCompute(100);
    expect(hundredSeats.monthlyCredits).toBe(250_000);
    expect(hundredSeats.runtimeHours).toBeCloseTo(12_418.5344, 4);
  });
});
