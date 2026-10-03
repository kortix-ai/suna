import { expect, test } from 'bun:test';
import { isoValue, numberValue } from './cost-values';

test('canonical numeric value preserves finite coercion and nonfinite fallback', () => {
  for (const value of [null, undefined, '', 'invalid', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    expect(numberValue(value)).toBe(0);
  expect(numberValue('12.5')).toBe(12.5);
  expect(numberValue('-2')).toBe(-2);
  expect(numberValue(1.25)).toBe(1.25);
});

test('canonical ISO value preserves invalid dates, nulls and timezone normalization', () => {
  for (const value of [null, undefined, '', 'invalid', new Date(Number.NaN)])
    expect(isoValue(value)).toBeNull();
  expect(isoValue('2026-01-01T01:00:00+01:00')).toBe('2026-01-01T00:00:00.000Z');
  expect(isoValue(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
});
