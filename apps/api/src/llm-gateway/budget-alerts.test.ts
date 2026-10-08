import { describe, expect, test } from 'bun:test';
import { startOfBudgetPeriod } from './budget-alerts';

// The once-per-period key must name the same period as checkBudget's
// `date_trunc(period, now())` (UTC, weeks start on Monday).
describe('startOfBudgetPeriod', () => {
  const at = (iso: string) => new Date(iso);

  test('a day starts at UTC midnight', () => {
    expect(startOfBudgetPeriod('day', at('2026-10-08T23:59:59Z')).toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  test('a week starts on Monday, including from a Sunday', () => {
    expect(startOfBudgetPeriod('week', at('2026-10-08T10:00:00Z')).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(startOfBudgetPeriod('week', at('2026-10-11T23:00:00Z')).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(startOfBudgetPeriod('week', at('2026-10-05T00:00:00Z')).toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  test('a month starts on the 1st', () => {
    expect(startOfBudgetPeriod('month', at('2026-10-31T12:00:00Z')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});
