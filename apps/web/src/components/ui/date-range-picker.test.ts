import { describe, expect, test } from 'bun:test';

import { formatRangeLabel, resolvePreset } from './date-range-picker';

const NOW = new Date('2026-08-01T12:00:00.000Z');

describe('resolvePreset', () => {
  test('7d spans exactly seven days ending now', () => {
    const range = resolvePreset('7d', NOW);
    expect(range.to).toBe('2026-08-01T12:00:00.000Z');
    expect(range.from).toBe('2026-07-25T12:00:00.000Z');
    expect(range.preset).toBe('7d');
  });

  test('24h spans one day', () => {
    expect(resolvePreset('24h', NOW).from).toBe('2026-07-31T12:00:00.000Z');
  });

  test('90d spans ninety days', () => {
    expect(resolvePreset('90d', NOW).from).toBe('2026-05-03T12:00:00.000Z');
  });
});

describe('formatRangeLabel', () => {
  test('names a preset range', () => {
    expect(formatRangeLabel(resolvePreset('30d', NOW))).toBe('Last 30 days');
  });

  test('shows both dates for a custom range', () => {
    expect(
      formatRangeLabel({
        preset: 'custom',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-15T00:00:00.000Z',
      }),
    ).toBe('Jul 1 – Jul 15, 2026');
  });
});
