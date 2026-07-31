import { describe, expect, test } from 'bun:test';
import { planSummary } from './plan-card';

describe('planSummary', () => {
  test('counts completed todos and rounds the percentage', () => {
    const summary = planSummary([
      { status: 'completed', content: 'a' },
      { status: 'completed', content: 'b' },
      { status: 'completed', content: 'c' },
      { status: 'in_progress', content: 'd' },
      { status: 'pending', content: 'e' },
      { status: 'pending', content: 'f' },
      { status: 'pending', content: 'g' },
    ]);

    expect(summary.done).toBe(3);
    expect(summary.total).toBe(7);
    expect(summary.percent).toBe(43);
    expect(summary.current).toBe('d');
  });

  test('current is the in_progress item', () => {
    const summary = planSummary([
      { status: 'completed', content: 'done' },
      { status: 'in_progress', content: 'Auditing worker registration' },
    ]);
    expect(summary.current).toBe('Auditing worker registration');
  });

  test('no in_progress item leaves current undefined', () => {
    const summary = planSummary([{ status: 'pending', content: 'a' }]);
    expect(summary.current).toBeUndefined();
  });

  test('an all-complete plan is 100 percent with no current item', () => {
    const summary = planSummary([
      { status: 'completed', content: 'a' },
      { status: 'completed', content: 'b' },
    ]);
    expect(summary.percent).toBe(100);
    expect(summary.current).toBeUndefined();
  });

  test('an empty plan is zero percent and does not divide by zero', () => {
    const summary = planSummary([]);
    expect(summary).toEqual({ done: 0, total: 0, percent: 0, current: undefined });
  });

  test('cancelled todos count toward the total but not toward done', () => {
    const summary = planSummary([
      { status: 'completed', content: 'a' },
      { status: 'cancelled', content: 'b' },
    ]);
    expect(summary.done).toBe(1);
    expect(summary.total).toBe(2);
  });
});
