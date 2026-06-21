import { describe, test, expect } from 'bun:test';
import {
  AUTO_TOPUP_DEFAULT_THRESHOLD,
  AUTO_TOPUP_DEFAULT_AMOUNT,
  AUTO_TOPUP_MIN_THRESHOLD,
  AUTO_TOPUP_MIN_AMOUNT,
} from './auto-topup';

describe('auto-topup constants', () => {
  test('default amount is at least the minimum amount', () => {
    expect(AUTO_TOPUP_DEFAULT_AMOUNT).toBeGreaterThanOrEqual(AUTO_TOPUP_MIN_AMOUNT);
  });

  test('default threshold is at least the minimum threshold', () => {
    expect(AUTO_TOPUP_DEFAULT_THRESHOLD).toBeGreaterThanOrEqual(AUTO_TOPUP_MIN_THRESHOLD);
  });

  test('all values are positive numbers', () => {
    const values = [
      AUTO_TOPUP_DEFAULT_THRESHOLD,
      AUTO_TOPUP_DEFAULT_AMOUNT,
      AUTO_TOPUP_MIN_THRESHOLD,
      AUTO_TOPUP_MIN_AMOUNT,
    ];
    for (const value of values) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
    }
  });
});
