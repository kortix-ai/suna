import { describe, expect, test } from 'bun:test';

import {
  formatSessionCostDuration,
  formatSessionCostExactUsd,
  formatSessionCostUsd,
} from './session-cost-format';

describe('formatSessionCostUsd', () => {
  test('formats standard costs with two decimal places', () => {
    expect(formatSessionCostUsd(12.5)).toBe('$12.50');
  });

  test('collapses non-zero costs below one cent to a threshold label', () => {
    expect(formatSessionCostUsd(0.004321)).toBe('<$0.01');
    expect(formatSessionCostUsd(0.0000000042)).toBe('<$0.01');
    expect(formatSessionCostUsd(0.0099)).toBe('<$0.01');
  });

  test('does not collapse one cent or more', () => {
    expect(formatSessionCostUsd(0.01)).toBe('$0.01');
  });

  test('formats negative costs without the threshold label', () => {
    expect(formatSessionCostUsd(-2.5)).toBe('-$2.50');
  });

  test('formats zero without insignificant precision', () => {
    expect(formatSessionCostUsd(0)).toBe('$0.00');
  });
});

describe('formatSessionCostExactUsd', () => {
  test('keeps full precision for sub-cent costs', () => {
    expect(formatSessionCostExactUsd(0.0030428596)).toBe('$0.0030428596');
  });

  test('still shows two decimals for whole-cent costs', () => {
    expect(formatSessionCostExactUsd(12.5)).toBe('$12.50');
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
