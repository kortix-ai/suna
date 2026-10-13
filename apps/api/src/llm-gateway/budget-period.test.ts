import { describe, expect, test } from 'bun:test';
import { budgetPeriodResetsAt, startOfBudgetPeriod } from './budgets';

// The gate (checkBudget), the budgets route and the once-per-period alert key
// all read a budget's period through these two functions (UTC, weeks start on
// Monday).
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

describe('budgetPeriodResetsAt', () => {
  const at = (iso: string) => new Date(iso);

  test('a day resets at the next UTC midnight, also on the last instant of the day', () => {
    expect(budgetPeriodResetsAt('day', at('2026-10-13T09:30:00Z')).toISOString()).toBe('2026-10-14T00:00:00.000Z');
    expect(budgetPeriodResetsAt('day', at('2026-10-13T23:59:59.999Z')).toISOString()).toBe('2026-10-14T00:00:00.000Z');
    expect(budgetPeriodResetsAt('day', at('2026-10-14T00:00:00Z')).toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  test('a week resets on the next Monday, also from a Sunday and across a month', () => {
    expect(budgetPeriodResetsAt('week', at('2026-10-08T10:00:00Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(budgetPeriodResetsAt('week', at('2026-10-11T23:00:00Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(budgetPeriodResetsAt('week', at('2026-10-30T12:00:00Z')).toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  test('a month resets on the 1st of the next month, across a year and after a 31st', () => {
    expect(budgetPeriodResetsAt('month', at('2026-10-31T12:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(budgetPeriodResetsAt('month', at('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(budgetPeriodResetsAt('month', at('2027-01-31T08:00:00Z')).toISOString()).toBe('2027-02-01T00:00:00.000Z');
  });
});
