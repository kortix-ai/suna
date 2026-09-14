import { describe, expect, test } from 'bun:test';
import { BUDGET_REPORT_INTERVAL_MS, decideBudgetReport } from './budget-report-policy';

const HOUR = 60 * 60_000;

describe('decideBudgetReport', () => {
  test('speaks the moment the condition arrives', () => {
    expect(
      decideBudgetReport({ unresolved: true, state: { lastReportedAtMs: null }, nowMs: HOUR }),
    ).toBe('report');
  });

  test('stays quiet on the passes right after', () => {
    // The regression: the GC runs every few minutes, so the same sentence was
    // written 1,936 times in seven days with nothing changing between them.
    expect(
      decideBudgetReport({
        unresolved: true,
        state: { lastReportedAtMs: HOUR },
        nowMs: HOUR + 4 * 60_000,
      }),
    ).toBe('stay_quiet');
  });

  test('speaks again once an hour so a long incident cannot go silent', () => {
    expect(
      decideBudgetReport({
        unresolved: true,
        state: { lastReportedAtMs: HOUR },
        nowMs: HOUR + BUDGET_REPORT_INTERVAL_MS,
      }),
    ).toBe('report');
  });

  test('speaks once when the condition clears, then stays quiet', () => {
    expect(
      decideBudgetReport({ unresolved: false, state: { lastReportedAtMs: HOUR }, nowMs: 2 * HOUR }),
    ).toBe('report');
    expect(
      decideBudgetReport({ unresolved: false, state: { lastReportedAtMs: null }, nowMs: 2 * HOUR }),
    ).toBe('stay_quiet');
  });
});
