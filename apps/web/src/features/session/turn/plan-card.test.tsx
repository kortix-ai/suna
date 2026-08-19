import { describe, expect, test } from 'bun:test';
import { planPieState, planSummary } from './plan-card';

describe('planPieState', () => {
  test('the wedge is the completed share of a full turn', () => {
    expect(planPieState(3, 4, false).sweep).toBe(270); // the 75% cake
    expect(planPieState(2, 5, true).sweep).toBe(144);
    expect(planPieState(1, 4, false).sweep).toBe(90);
  });

  test('a finished plan sweeps the full circle and reports complete', () => {
    expect(planPieState(4, 4, false)).toEqual({ sweep: 360, state: 'complete' });
  });

  test('complete wins over running — a plan cannot be both', () => {
    expect(planPieState(4, 4, true).state).toBe('complete');
  });

  test('a running plan reports running', () => {
    expect(planPieState(2, 5, true).state).toBe('running');
  });

  test('an untouched plan draws bare track', () => {
    expect(planPieState(0, 5, false)).toEqual({ sweep: 0, state: 'idle' });
  });

  test('an empty plan does not divide by zero and is never "complete"', () => {
    // 0 === 0 would read as complete without the `total > 0` guard.
    expect(planPieState(0, 0, false)).toEqual({ sweep: 0, state: 'idle' });
    expect(Number.isNaN(planPieState(0, 0, false).sweep)).toBe(false);
  });
});

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
