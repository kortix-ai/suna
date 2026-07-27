import { describe, expect, test } from 'bun:test';
import {
  InvalidUsageQueryError,
  mapUsageBreakdownRow,
  mapUsageTotals,
  parseUsageQuery,
} from './usage-query';

describe('parseUsageQuery', () => {
  test('returns an empty object when no params are given', () => {
    expect(parseUsageQuery({})).toEqual({});
  });

  test('parses valid start/end ISO timestamps into Dates', () => {
    const result = parseUsageQuery({ start: '2026-07-01T00:00:00Z', end: '2026-07-17T00:00:00Z' });

    expect(result.start).toBeInstanceOf(Date);
    expect(result.end).toBeInstanceOf(Date);
    expect(result.start?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(result.end?.toISOString()).toBe('2026-07-17T00:00:00.000Z');
  });

  test('parses a valid group_by', () => {
    expect(parseUsageQuery({ group_by: 'model' }).groupBy).toBe('model');
    expect(parseUsageQuery({ group_by: 'provider' }).groupBy).toBe('provider');
    expect(parseUsageQuery({ group_by: 'day' }).groupBy).toBe('day');
  });

  test('treats empty-string params as absent', () => {
    expect(parseUsageQuery({ start: '', end: '', group_by: '' })).toEqual({});
  });

  test('rejects an unparseable start timestamp', () => {
    expect(() => parseUsageQuery({ start: 'not-a-date' })).toThrow(InvalidUsageQueryError);
  });

  test('rejects an unparseable end timestamp', () => {
    expect(() => parseUsageQuery({ end: 'not-a-date' })).toThrow(InvalidUsageQueryError);
  });

  test('rejects an invalid group_by value', () => {
    expect(() => parseUsageQuery({ group_by: 'bogus' })).toThrow(InvalidUsageQueryError);
  });

  test('rejects start after end', () => {
    expect(() =>
      parseUsageQuery({ start: '2026-07-17T00:00:00Z', end: '2026-07-01T00:00:00Z' }),
    ).toThrow(InvalidUsageQueryError);
  });

  test('accepts start equal to end (zero-width window)', () => {
    const iso = '2026-07-17T00:00:00Z';
    expect(() => parseUsageQuery({ start: iso, end: iso })).not.toThrow();
  });
});

describe('mapUsageTotals', () => {
  test('coerces a full aggregate row to numbers', () => {
    const result = mapUsageTotals({
      totalInputTokens: '1000',
      totalOutputTokens: '2000',
      totalCachedTokens: '150',
      totalCacheWriteTokens: '75',
      totalCost: '3.456',
      count: '42',
    });

    expect(result).toEqual({
      total_input_tokens: 1000,
      total_output_tokens: 2000,
      total_cached_tokens: 150,
      total_cache_write_tokens: 75,
      total_cost: 3.456,
      count: 42,
    });
  });

  test('defaults every field to zero for an undefined row (empty window)', () => {
    expect(mapUsageTotals(undefined)).toEqual({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost: 0,
      count: 0,
    });
  });

  test('defaults null fields within a present row to zero', () => {
    const result = mapUsageTotals({
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCachedTokens: null,
      totalCacheWriteTokens: null,
      totalCost: null,
      count: null,
    });

    expect(result).toEqual({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost: 0,
      count: 0,
    });
  });
});

describe('mapUsageBreakdownRow', () => {
  test('maps a day-grouped row', () => {
    const result = mapUsageBreakdownRow({
      day: '2026-07-17',
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 5,
      cacheWriteTokens: 2,
      cost: 0.5,
      count: 3,
    });

    expect(result).toEqual({
      day: '2026-07-17',
      input_tokens: 10,
      output_tokens: 20,
      cached_tokens: 5,
      cache_write_tokens: 2,
      cost: 0.5,
      count: 3,
    });
  });

  test('maps a model-grouped row with its provider', () => {
    const result = mapUsageBreakdownRow({
      provider: 'bedrock',
      model: 'anthropic/claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 200,
      cachedTokens: 0,
      cacheWriteTokens: 10,
      cost: 1.2,
      count: 7,
    });

    expect(result).toEqual({
      provider: 'bedrock',
      model: 'anthropic/claude-sonnet-5',
      input_tokens: 100,
      output_tokens: 200,
      cached_tokens: 0,
      cache_write_tokens: 10,
      cost: 1.2,
      count: 7,
    });
  });

  test('maps a provider-only-grouped row', () => {
    const result = mapUsageBreakdownRow({
      provider: 'openrouter',
      inputTokens: 50,
      outputTokens: 60,
      cachedTokens: 10,
      cacheWriteTokens: 4,
      cost: 0.75,
      count: 4,
    });

    expect(result).toEqual({
      provider: 'openrouter',
      input_tokens: 50,
      output_tokens: 60,
      cached_tokens: 10,
      cache_write_tokens: 4,
      cost: 0.75,
      count: 4,
    });
  });

  test('defaults a null provider to null rather than dropping the key', () => {
    const result = mapUsageBreakdownRow({
      provider: null,
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.01,
      count: 1,
    });

    expect(result).toEqual({
      provider: null,
      input_tokens: 1,
      output_tokens: 1,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cost: 0.01,
      count: 1,
    });
  });
});

/**
 * Kortix-as-a-Backend per-end-user metering: `origin_ref` as both a filter and a
 * group_by dimension on GET /v1/usage.
 */
describe('usage — origin_ref (per-end-user metering)', () => {
  test('accepts and trims an origin_ref filter', () => {
    expect(parseUsageQuery({ origin_ref: '  user-123  ' })).toEqual({ originRef: 'user-123' });
  });

  test('an absent or empty origin_ref simply means "no filter"', () => {
    expect(parseUsageQuery({})).toEqual({});
    expect(parseUsageQuery({ origin_ref: '' })).toEqual({});
  });

  test('rejects a blank-but-present origin_ref rather than silently ignoring it', () => {
    // '   ' is a caller mistake, not "everyone" — failing loudly beats quietly
    // returning account-wide totals the caller would read as one user's spend.
    expect(() => parseUsageQuery({ origin_ref: '   ' })).toThrow(InvalidUsageQueryError);
  });

  test('rejects an over-long origin_ref (mirrors the session-create bound)', () => {
    expect(() => parseUsageQuery({ origin_ref: 'x'.repeat(257) })).toThrow(InvalidUsageQueryError);
    expect(parseUsageQuery({ origin_ref: 'x'.repeat(256) }).originRef).toHaveLength(256);
  });

  test('accepts origin_ref as a group_by dimension', () => {
    expect(parseUsageQuery({ group_by: 'origin_ref' })).toEqual({ groupBy: 'origin_ref' });
  });

  test('still rejects an unknown group_by, and names origin_ref as an option', () => {
    let message = '';
    try {
      parseUsageQuery({ group_by: 'end_user' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('origin_ref');
  });

  test('maps an origin_ref breakdown row to an origin_ref-keyed entry', () => {
    expect(
      mapUsageBreakdownRow({
        originRef: 'user-123',
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.25,
        count: 2,
      }),
    ).toEqual({
      origin_ref: 'user-123',
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cost: 0.25,
      count: 2,
    });
  });

  test('an origin_ref row never degrades into the provider shape', () => {
    // mapUsageBreakdownRow dispatches on which key is present; origin_ref must
    // win before the provider fallback or a per-user report would come back
    // keyed by provider.
    const row = mapUsageBreakdownRow({
      originRef: 'user-9',
      provider: 'anthropic',
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.01,
      count: 1,
    });
    expect(row).toHaveProperty('origin_ref', 'user-9');
    expect(row).not.toHaveProperty('provider');
  });
});

