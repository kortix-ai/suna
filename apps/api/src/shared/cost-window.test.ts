import { describe, expect, test } from 'bun:test';

import {
  InvalidCostQueryError,
  MAX_COST_OFFSET,
  parseCostPagination,
  parseCostSort,
  parseCostWindow,
} from './cost-window';

describe('parseCostWindow', () => {
  test('parses an explicit ISO window', () => {
    const window = parseCostWindow({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });
    expect(window.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  test('defaults to a 30 day window ending now when both bounds are absent', () => {
    const window = parseCostWindow({});
    const spanDays = (window.to.getTime() - window.from.getTime()) / 86_400_000;
    expect(Math.round(spanDays)).toBe(30);
  });

  test('rejects a non-ISO bound', () => {
    expect(() => parseCostWindow({ from: 'yesterday' })).toThrow(InvalidCostQueryError);
  });

  test('rejects an inverted window', () => {
    expect(() =>
      parseCostWindow({
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
      }),
    ).toThrow(InvalidCostQueryError);
  });

  test('rejects a window longer than one year', () => {
    expect(() =>
      parseCostWindow({
        from: '2024-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
      }),
    ).toThrow(InvalidCostQueryError);
  });
});

describe('parseCostSort', () => {
  test('returns the fallback when absent', () => {
    expect(parseCostSort(undefined, ['total_desc', 'recent'], 'total_desc')).toBe('total_desc');
  });

  test('returns an allowed value', () => {
    expect(parseCostSort('recent', ['total_desc', 'recent'], 'total_desc')).toBe('recent');
  });

  test('rejects a value outside the allowed set', () => {
    expect(() => parseCostSort('name_asc', ['total_desc', 'recent'], 'total_desc')).toThrow(
      InvalidCostQueryError,
    );
  });
});

describe('parseCostPagination', () => {
  test('defaults to 25 rows at offset 0', () => {
    expect(parseCostPagination({})).toEqual({ limit: 25, offset: 0 });
  });

  test('rejects an offset beyond the cap', () => {
    expect(() => parseCostPagination({ offset: String(MAX_COST_OFFSET + 1) })).toThrow(
      InvalidCostQueryError,
    );
  });

  test('rejects a non-integer limit', () => {
    expect(() => parseCostPagination({ limit: '10.5' })).toThrow(InvalidCostQueryError);
  });
});
