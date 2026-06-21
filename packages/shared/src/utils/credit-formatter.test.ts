import { describe, test, expect } from 'bun:test';
import {
  CREDITS_PER_DOLLAR,
  dollarsToCredits,
  creditsToDollars,
  formatCredits,
  formatCreditsWithSign,
  formatDollarsAsCredits,
} from './credit-formatter';

describe('dollarsToCredits / creditsToDollars', () => {
  test('converts dollars to credits and back', () => {
    expect(dollarsToCredits(1)).toBe(CREDITS_PER_DOLLAR);
    expect(dollarsToCredits(2.5)).toBe(250);
    expect(creditsToDollars(100)).toBe(1);
    expect(creditsToDollars(250)).toBe(2.5);
  });

  test('rounds fractional credits when converting from dollars', () => {
    expect(dollarsToCredits(0.005)).toBe(1); // 0.5 credits -> rounds to 1
    expect(dollarsToCredits(0.004)).toBe(0); // 0.4 credits -> rounds to 0
  });
});

describe('formatCredits', () => {
  test('formats integers with thousand separators', () => {
    expect(formatCredits(1000)).toBe('1,000');
    expect(formatCredits(1234567)).toBe('1,234,567');
    expect(formatCredits(0)).toBe('0');
  });

  test('handles null / undefined / NaN', () => {
    expect(formatCredits(null)).toBe('0');
    expect(formatCredits(undefined)).toBe('0');
    expect(formatCredits(NaN)).toBe('0');
  });

  test('never renders negative zero for tiny negatives', () => {
    // Math.round(-0.4) === -0, which used to stringify as "-0".
    expect(formatCredits(-0.4)).toBe('0');
    expect(formatCredits(-0.49)).toBe('0');
    expect(formatCredits(-0)).toBe('0');
  });

  test('rounds to nearest integer by default', () => {
    expect(formatCredits(12.4)).toBe('12');
    expect(formatCredits(12.5)).toBe('13');
    expect(formatCredits(-12.4)).toBe('-12');
  });

  test('shows two decimals when requested', () => {
    expect(formatCredits(1234.5, { showDecimals: true })).toBe('1,234.50');
    expect(formatCredits(0, { showDecimals: true })).toBe('0.00');
  });
});

describe('formatCreditsWithSign', () => {
  test('prefixes a sign based on value', () => {
    expect(formatCreditsWithSign(100)).toBe('+100');
    expect(formatCreditsWithSign(-100)).toBe('-100');
    expect(formatCreditsWithSign(0)).toBe('+0');
  });

  test('handles null / undefined / NaN', () => {
    expect(formatCreditsWithSign(null)).toBe('0');
    expect(formatCreditsWithSign(undefined)).toBe('0');
    expect(formatCreditsWithSign(NaN)).toBe('0');
  });

  test('tiny negatives that round to zero read as "+0", never "-0"', () => {
    expect(formatCreditsWithSign(-0.4)).toBe('+0');
    expect(formatCreditsWithSign(-0.49)).toBe('+0');
    expect(formatCreditsWithSign(-0)).toBe('+0');
  });

  test('keeps the sign for amounts that round to a nonzero magnitude', () => {
    expect(formatCreditsWithSign(-0.5)).toBe('-1');
    expect(formatCreditsWithSign(-12.4)).toBe('-12');
    expect(formatCreditsWithSign(12.4)).toBe('+12');
  });
});

describe('formatDollarsAsCredits', () => {
  test('converts dollars to a formatted credit string', () => {
    expect(formatDollarsAsCredits(1)).toBe('100');
    expect(formatDollarsAsCredits(12.34)).toBe('1,234');
  });
});
