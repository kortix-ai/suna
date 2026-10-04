import { describe, expect, test } from 'bun:test';
import { AnonymousAuditBudget } from './audit-anonymous-budget';

describe('anonymous audit budget', () => {
  test('admits up to the per-second capacity, then suppresses', () => {
    const budget = new AnonymousAuditBudget({ perSecond: 3, summaryEveryMs: 60_000 });
    const admitted = [0, 1, 2, 3, 4].map((i) => budget.admit(1_000 + i, 401).admit);
    expect(admitted).toEqual([true, true, true, false, false]);
  });

  test('a new second admits again', () => {
    const budget = new AnonymousAuditBudget({ perSecond: 1, summaryEveryMs: 60_000 });
    expect(budget.admit(1_000, 401).admit).toBe(true);
    expect(budget.admit(1_500, 401).admit).toBe(false);
    expect(budget.admit(2_000, 401).admit).toBe(true);
  });

  test('suppressed rows are accounted for in one summary, grouped by status class', () => {
    const budget = new AnonymousAuditBudget({ perSecond: 1, summaryEveryMs: 60_000 });
    budget.admit(1_000, 200);
    budget.admit(1_001, 401);
    budget.admit(1_002, 404);
    budget.admit(1_003, 404);
    budget.admit(1_004, 503);

    // The window opens at the first SUPPRESSED row (1_001; the row at 1_000
    // was admitted), so it is due 60s after that.
    const later = budget.admit(61_001, 401);

    expect(later.admit).toBe(true);
    expect(later.summary).toEqual({
      windowStartMs: 1_001,
      windowEndMs: 61_001,
      suppressed: 4,
      byStatusClass: { '4xx': 3, '5xx': 1 },
    });
  });

  test('no summary is produced when nothing was suppressed', () => {
    const budget = new AnonymousAuditBudget({ perSecond: 10, summaryEveryMs: 60_000 });
    budget.admit(1_000, 200);
    expect(budget.admit(90_000, 200).summary).toBeUndefined();
  });

  test('a summary is released at most once per summary window during a sustained flood', () => {
    const budget = new AnonymousAuditBudget({ perSecond: 1, summaryEveryMs: 60_000 });
    const summaries = [];
    for (let t = 0; t < 180_000; t += 100) {
      const decision = budget.admit(t, 401);
      if (decision.summary) summaries.push(decision.summary);
    }
    // Three minutes of flood: summaries at t=60s and t=120s; the third window
    // is still open and is released by drainSummary().
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.suppressed > 0)).toBe(true);
    const tail = budget.drainSummary(180_000);
    expect(tail?.suppressed).toBeGreaterThan(0);
    expect(budget.drainSummary(180_001)).toBeUndefined();
  });

  test('capacity comes from the environment and defaults to 50 per second', () => {
    expect(AnonymousAuditBudget.perSecondFromEnv(undefined)).toBe(50);
    expect(AnonymousAuditBudget.perSecondFromEnv('7')).toBe(7);
    expect(AnonymousAuditBudget.perSecondFromEnv('0')).toBe(50);
    expect(AnonymousAuditBudget.perSecondFromEnv('garbage')).toBe(50);
  });
});
