import { expect, mock, test } from 'bun:test';
mock.module('../../lib/db', () => ({ db: {}, hasDatabase: true }));
const { mergeLegacyGatewaySessionRows, computeBilledSeconds } = await import('./session-costs');
const { splitLlmSpend } = await import('./llm-spend');
const numbers = [null, undefined, '', '12.5', '-2', 'garbage', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1.25];
const expected = [0, 0, 0, 12.5, -2, 0, 0, 0, 0, 0, 1.25];
test('finite normalization preserves null, strings, nonfinite and signed values', () => {
  for (const [index, value] of numbers.entries()) {
    expect(
      splitLlmSpend({ billingMode: 'credits', upstreamCost: 0, finalCost: value }).kortix_cost,
    ).toBe(expected[index]);
    const rows = mergeLegacyGatewaySessionRows(
      [
        {
          sessionId: 'synthetic-session',
          cost: value,
          requests: value,
          errors: value,
          tokens: value,
          models: value,
          lastAt: null,
        },
      ],
      [],
    );
    expect(rows[0]?.llm_cost).toBe(expected[index]);
  }
});
test('ISO normalization preserves invalid and valid Date/string values', () => {
  for (const value of [null, undefined, '', 'invalid', new Date(Number.NaN)]) {
    expect(
      mergeLegacyGatewaySessionRows(
        [],
        [{ sessionId: 'synthetic-session', cost: 0, seconds: 0, lastAt: value }],
      )[0]?.last_at,
    ).toBeNull();
    expect(computeBilledSeconds(value, new Date())).toBe(0);
  }
  for (const value of ['2026-01-01T01:00:00+01:00', new Date('2026-01-01T00:00:00Z')]) {
    expect(
      mergeLegacyGatewaySessionRows(
        [],
        [{ sessionId: 'synthetic-session', cost: 0, seconds: 0, lastAt: value }],
      )[0]?.last_at,
    ).toBe('2026-01-01T00:00:00.000Z');
  }
});
