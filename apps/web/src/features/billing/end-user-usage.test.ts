import { describe, expect, test } from 'bun:test';
import { toEndUserUsageRows } from './end-user-usage';

const item = (origin_ref: string | undefined, cost: number, count = 1) => ({
  origin_ref,
  cost,
  count,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
});

describe('toEndUserUsageRows', () => {
  test('drops rows with no origin_ref — those are not any end-user’s spend', () => {
    // Interactive dashboard sessions, and every event written before the column
    // existed, have a NULL origin_ref. Folding them in would bill them to someone.
    const rows = toEndUserUsageRows([item('user-a', 2), item(undefined, 99), item('', 50)]);
    expect(rows.map((r) => r.originRef)).toEqual(['user-a']);
  });

  test('sorts by spend so the most expensive end-user reads first', () => {
    const rows = toEndUserUsageRows([item('cheap', 1), item('pricey', 9), item('mid', 5)]);
    expect(rows.map((r) => r.originRef)).toEqual(['pricey', 'mid', 'cheap']);
  });

  test('breaks ties by id so the order never flickers between renders', () => {
    const rows = toEndUserUsageRows([item('b', 3), item('a', 3)]);
    expect(rows.map((r) => r.originRef)).toEqual(['a', 'b']);
  });

  test('share is a fraction of the listed spend, excluding unattributed rows', () => {
    const rows = toEndUserUsageRows([item('a', 3), item('b', 1), item(undefined, 96)]);
    expect(rows.find((r) => r.originRef === 'a')?.share).toBeCloseTo(0.75);
    expect(rows.find((r) => r.originRef === 'b')?.share).toBeCloseTo(0.25);
  });

  test('zero total yields zero share rather than NaN', () => {
    const rows = toEndUserUsageRows([item('a', 0), item('b', 0)]);
    expect(rows.every((r) => r.share === 0)).toBe(true);
  });

  test('an absent breakdown is empty, so the card can hide itself', () => {
    expect(toEndUserUsageRows(undefined)).toEqual([]);
  });
});
