import { describe, expect, test } from 'bun:test';

import { formatSessionCostDuration, formatSessionCostUsd } from './session-cost-format';

describe('formatSessionCostUsd', () => {
  test('formats standard costs with two decimal places', () => {
    expect(formatSessionCostUsd(12.5)).toBe('$12.50');
  });

  test('preserves precision for non-zero costs below one cent', () => {
    expect(formatSessionCostUsd(0.004321)).toBe('$0.004321');
    expect(formatSessionCostUsd(0.0000000042)).toBe('$0.0000000042');
  });

  test('formats zero without insignificant precision', () => {
    expect(formatSessionCostUsd(0)).toBe('$0.00');
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
