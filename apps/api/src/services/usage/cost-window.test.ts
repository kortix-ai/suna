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

  test('rejects an empty window where from equals to', () => {
    expect(() =>
      parseCostWindow({
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
      }),
    ).toThrow(InvalidCostQueryError);
  });

  test('accepts a window of exactly the 366 day max span', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 366 * 86_400_000);
    const window = parseCostWindow({ from: from.toISOString(), to: to.toISOString() });
    expect(window.to.getTime() - window.from.getTime()).toBe(366 * 86_400_000);
  });

  test('rejects a window one day beyond the 366 day max span', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 367 * 86_400_000);
    expect(() => parseCostWindow({ from: from.toISOString(), to: to.toISOString() })).toThrow(
      InvalidCostQueryError,
    );
  });

  test('rejects a bare local date-time with no UTC designator or offset', () => {
    // Per the ECMAScript Date Time String Format, a date-time with no `Z` or
    // numeric offset parses as *local* time, not UTC. That would silently
    // violate the "always UTC" window contract depending on server TZ.
    expect(() => parseCostWindow({ from: '2026-07-01T00:00:00.000' })).toThrow(
      InvalidCostQueryError,
    );
  });

  test('rejects a non-ISO format such as a US-style date', () => {
    expect(() => parseCostWindow({ from: '07/01/2026' })).toThrow(InvalidCostQueryError);
  });

  test('accepts a numeric offset and resolves it to the correct UTC instant', () => {
    const window = parseCostWindow({
      from: '2026-07-01T05:30:00+05:30',
      to: '2026-08-01T00:00:00Z',
    });
    expect(window.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('accepts a date-only bound as UTC midnight', () => {
    const window = parseCostWindow({ from: '2026-07-01', to: '2026-08-01T00:00:00.000Z' });
    expect(window.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
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

  test('accepts an offset exactly at the cap', () => {
    expect(parseCostPagination({ offset: String(MAX_COST_OFFSET) })).toEqual({
      limit: 25,
      offset: MAX_COST_OFFSET,
    });
  });

  test('rejects a non-integer limit', () => {
    expect(() => parseCostPagination({ limit: '10.5' })).toThrow(InvalidCostQueryError);
  });

  test('rejects a limit of zero', () => {
    expect(() => parseCostPagination({ limit: '0' })).toThrow(InvalidCostQueryError);
  });

  test('accepts a limit of 1', () => {
    expect(parseCostPagination({ limit: '1' })).toEqual({ limit: 1, offset: 0 });
  });

  test('accepts a limit of 100', () => {
    expect(parseCostPagination({ limit: '100' })).toEqual({ limit: 100, offset: 0 });
  });

  test('rejects a limit of 101', () => {
    expect(() => parseCostPagination({ limit: '101' })).toThrow(InvalidCostQueryError);
  });
});
