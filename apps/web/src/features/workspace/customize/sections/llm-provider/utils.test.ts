import { describe, expect, test } from 'bun:test';

import { formatPricePerMillion, formatTokenCount, gatewayModelId } from './utils';

describe('gatewayModelId', () => {
  test('BYOK provider gets a provider/model wire id', () => {
    expect(gatewayModelId({ id: 'anthropic', managed: false }, 'claude-sonnet-4.6')).toBe(
      'anthropic/claude-sonnet-4.6',
    );
  });

  test('managed Kortix provider stays bare (single-segment)', () => {
    expect(gatewayModelId({ id: 'kortix', managed: true }, 'claude-opus-4.8')).toBe(
      'claude-opus-4.8',
    );
  });

  test('codex (ChatGPT subscription) gets a codex/ prefix', () => {
    expect(gatewayModelId({ id: 'codex', managed: false }, 'gpt-5.6-sol')).toBe(
      'codex/gpt-5.6-sol',
    );
  });
});

describe('formatTokenCount', () => {
  test('formats millions with a decimal only when not whole', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });

  test('formats thousands rounded to the nearest K', () => {
    expect(formatTokenCount(128_000)).toBe('128K');
    expect(formatTokenCount(8_192)).toBe('8K');
  });

  test('formats sub-1000 values verbatim', () => {
    expect(formatTokenCount(512)).toBe('512');
  });

  test('returns empty string for falsy or non-positive input', () => {
    expect(formatTokenCount(undefined)).toBe('');
    expect(formatTokenCount(null)).toBe('');
    expect(formatTokenCount(0)).toBe('');
    expect(formatTokenCount(-5)).toBe('');
  });
});

describe('formatPricePerMillion', () => {
  test('formats whole-dollar rates with two decimals', () => {
    expect(formatPricePerMillion(3)).toBe('$3.00');
    expect(formatPricePerMillion(15)).toBe('$15.00');
  });

  test('formats sub-dollar rates with three decimals', () => {
    expect(formatPricePerMillion(0.25)).toBe('$0.250');
  });

  test('formats sub-cent rates with four decimals', () => {
    expect(formatPricePerMillion(0.0007)).toBe('$0.0007');
  });

  test('zero rate reads as Free', () => {
    expect(formatPricePerMillion(0)).toBe('Free');
  });

  test('returns empty string when the rate is unknown', () => {
    expect(formatPricePerMillion(null)).toBe('');
    expect(formatPricePerMillion(undefined)).toBe('');
  });
});
