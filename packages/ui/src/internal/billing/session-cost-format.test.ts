import { describe, expect, test } from 'bun:test';

import {
  formatSessionCostCredits,
  formatSessionCostDuration,
  formatSessionCostExactCredits,
} from './session-cost-format';

describe('formatSessionCostCredits', () => {
  test('converts USD to whole credits from 10 credits up', () => {
    expect(formatSessionCostCredits(12.5)).toBe('1,250');
    expect(formatSessionCostCredits(868.15)).toBe('86,815');
  });

  test('keeps up to two decimals below 10 credits, so a cheap turn never reads 0', () => {
    expect(formatSessionCostCredits(0.004321)).toBe('0.43');
    expect(formatSessionCostCredits(0.01)).toBe('1');
  });

  test('collapses a non-zero amount under 0.01 credits to a threshold label', () => {
    expect(formatSessionCostCredits(0.0000000042)).toBe('<0.01');
  });

  test('formats negative amounts and zero', () => {
    expect(formatSessionCostCredits(-2.5)).toBe('-250');
    expect(formatSessionCostCredits(0)).toBe('0');
    expect(formatSessionCostCredits(Number.NaN)).toBe('0');
  });

  test('groups by the locale', () => {
    expect(formatSessionCostCredits(868.15, 'de-DE')).toBe('86.815');
  });
});

describe('formatSessionCostExactCredits', () => {
  test('keeps full precision for amounts under 10 credits', () => {
    expect(formatSessionCostExactCredits(0.0030428596)).toBe('0.30428596');
  });

  test('two decimals at most from 10 credits up', () => {
    expect(formatSessionCostExactCredits(12.5)).toBe('1,250');
    expect(formatSessionCostExactCredits(0.123456)).toBe('12.35');
  });
});

describe('formatSessionCostDuration', () => {
  test('formats seconds, minutes, hours, and days without empty units', () => {
    expect(formatSessionCostDuration(0)).toBe('0s');
    expect(formatSessionCostDuration(59)).toBe('59s');
    expect(formatSessionCostDuration(61)).toBe('1m 1s');
    expect(formatSessionCostDuration(3661)).toBe('1h 1m');
    expect(formatSessionCostDuration(176460)).toBe('2d 1h');
  });
});
