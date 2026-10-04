/**
 * How often the unresolvable-snapshot-budget alarm is allowed to speak.
 *
 * `[snapshot-gc] BUDGET UNRESOLVED` is a real signal and must not be deleted:
 * the first outage in this area happened because a GC that could not cope
 * logged nothing. But it describes a STANDING condition — one warm tip per
 * active project already exceeds the org snapshot quota — and the GC pass runs
 * every few minutes, so the same sentence was written 1,936 times in seven days
 * (PROD, 7 days to 2026-09-10: `org` drifting 264 → 319 against `target=85`,
 * `limit=100`, ~11 per hour, every hour). Nothing in the fleet changed between
 * any two of them.
 *
 * An alarm that repeats every four minutes for a week is one nobody reads, so
 * it is edge-triggered instead: it speaks when the condition ARRIVES, again at
 * most once an hour while it persists (so a long-running incident cannot go
 * silent), and once more when it CLEARS. The numbers are in every line.
 *
 * No build failure was observed in that window — the eviction it reports is a
 * Daytona org limit and prod now bakes mostly on Platinum — so this is a
 * capacity decision for an operator (raise the quota, or gate the warm bake),
 * not something the GC can fix by sweeping harder.
 */

export const BUDGET_REPORT_INTERVAL_MS = 60 * 60_000;

export interface BudgetReportState {
  /** When the alarm last spoke, or null if it has not since the condition arrived. */
  lastReportedAtMs: number | null;
}

export type BudgetReportDecision = 'report' | 'stay_quiet';

/**
 * `unresolved` is this pass's verdict; `state.lastReportedAtMs` is null both
 * before the condition is first seen and after it clears, which is what makes
 * the arrival edge and the clear edge the same rule.
 */
export function decideBudgetReport(input: {
  unresolved: boolean;
  state: BudgetReportState;
  nowMs: number;
  intervalMs?: number;
}): BudgetReportDecision {
  if (!input.unresolved) return input.state.lastReportedAtMs === null ? 'stay_quiet' : 'report';
  if (input.state.lastReportedAtMs === null) return 'report';
  const interval = input.intervalMs ?? BUDGET_REPORT_INTERVAL_MS;
  return input.nowMs - input.state.lastReportedAtMs >= interval ? 'report' : 'stay_quiet';
}
