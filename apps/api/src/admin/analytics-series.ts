/**
 * Pure aggregation helpers for the admin activity-analytics endpoints.
 *
 * Kept free of `db`, hono, and env so they are unit-testable in isolation
 * (`analytics-series.test.ts`). `analytics.ts` runs the SQL, then folds the
 * sparse grouped rows into a DENSE day series through these functions.
 *
 * Why dense matters: a `GROUP BY date_trunc('day', ...)` only emits days that
 * have rows. A chart fed that sparse list draws a straight line across a
 * zero-activity gap, which reads as "steady" when the truth is "nothing
 * happened". Every helper here emits one entry per calendar day in the window,
 * zero-filled.
 *
 * All dates are UTC. The API is read by operators in several timezones, so a
 * server-local day boundary would make the same query return different numbers
 * on different machines.
 */

export const DEFAULT_ANALYTICS_DAYS = 30;
export const MAX_ANALYTICS_DAYS = 90;
export const MIN_ANALYTICS_DAYS = 1;

const MS_PER_DAY = 86_400_000;

/**
 * Clamp the `days` query param to [1, 90], defaulting to 30.
 *
 * Anything non-numeric (absent, empty, "abc", "NaN", "Infinity") falls back to
 * the default rather than erroring: this is a dashboard, and a 400 on a
 * hand-edited URL is worse than showing the default window. Fractional input is
 * truncated, so `?days=7.9` is 7 days, not a partial bucket.
 */
export function parseDays(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_ANALYTICS_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_ANALYTICS_DAYS;
  const truncated = Math.trunc(parsed);
  if (truncated < MIN_ANALYTICS_DAYS) return MIN_ANALYTICS_DAYS;
  if (truncated > MAX_ANALYTICS_DAYS) return MAX_ANALYTICS_DAYS;
  return truncated;
}

/** `YYYY-MM-DD` for the UTC calendar day containing `date`. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC at the start of the day containing `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The inclusive lower bound of a `days`-long window ending on the UTC day that
 * contains `now`. `days=1` is today only; `days=30` is today plus 29 days back.
 */
export function windowStart(days: number, now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() - (days - 1) * MS_PER_DAY);
}

/** Ascending `YYYY-MM-DD` keys for every UTC day in the window, oldest first. */
export function dayKeys(days: number, now: Date): string[] {
  const start = windowStart(days, now).getTime();
  return Array.from({ length: days }, (_, i) => utcDayKey(new Date(start + i * MS_PER_DAY)));
}

export interface ActivityDay {
  date: string;
  sessionsCreated: number;
  activeAccounts: number;
  activeUsers: number;
  newAccounts: number;
  activeWorkspaces: number;
}

/** One `GROUP BY day` row from kortix.project_sessions. */
export interface SessionDayRow {
  date: string;
  sessionsCreated: number;
  activeAccounts: number;
  activeUsers: number;
  activeWorkspaces: number;
}

/** One `GROUP BY day` row from kortix.accounts. */
export interface AccountDayRow {
  date: string;
  newAccounts: number;
}

/**
 * Zero-fill the session + signup rows across `keys`.
 *
 * Rows whose date is not in `keys` are dropped, not appended. A row can only
 * fall outside the window if the DB clock and the API clock disagree (the
 * window is computed in JS, the bucket in Postgres); silently widening the
 * series would put an off-by-one day on the end of every chart.
 */
export function buildActivityDays(
  keys: string[],
  sessionRows: readonly SessionDayRow[],
  accountRows: readonly AccountDayRow[],
): ActivityDay[] {
  const sessions = new Map(sessionRows.map((r) => [r.date, r]));
  const signups = new Map(accountRows.map((r) => [r.date, r.newAccounts]));
  return keys.map((date) => {
    const s = sessions.get(date);
    return {
      date,
      sessionsCreated: s?.sessionsCreated ?? 0,
      activeAccounts: s?.activeAccounts ?? 0,
      activeUsers: s?.activeUsers ?? 0,
      newAccounts: signups.get(date) ?? 0,
      activeWorkspaces: s?.activeWorkspaces ?? 0,
    };
  });
}

/** Spend category, mirroring `classifyLedgerKind` in billing/services/usage-breakdown.ts. */
export type SpendCategory = 'compute' | 'llm' | 'other';

/** One `GROUP BY day, category` row of debit totals (positive USD magnitudes). */
export interface LedgerDayRow {
  date: string;
  category: SpendCategory;
  usd: number;
}

/** One `GROUP BY day` row of distinct accounts that spent that day. */
export interface PayingAccountsDayRow {
  date: string;
  payingAccounts: number;
}

export interface UsageDay {
  date: string;
  computeUsd: number;
  llmUsd: number;
  otherUsd: number;
  totalUsd: number;
  payingAccounts: number;
}

/**
 * Zero-fill the ledger rows across `keys`, summing the per-category totals into
 * one entry per day. Multiple rows for the same (day, category) are added, so
 * the caller may pass raw per-ledger-kind rows already mapped to a category
 * without pre-merging `llm_debit` and `token_overage`.
 *
 * `totalUsd` is recomputed from the three parts rather than taken from a
 * separate SUM — a total that can disagree with its own breakdown is a bug
 * waiting to be reported as "the chart doesn't add up".
 */
export function buildUsageDays(
  keys: string[],
  ledgerRows: readonly LedgerDayRow[],
  payingRows: readonly PayingAccountsDayRow[],
): UsageDay[] {
  const byDay = new Map<string, { compute: number; llm: number; other: number }>();
  for (const row of ledgerRows) {
    const bucket = byDay.get(row.date) ?? { compute: 0, llm: 0, other: 0 };
    bucket[row.category] += row.usd;
    byDay.set(row.date, bucket);
  }
  const paying = new Map(payingRows.map((r) => [r.date, r.payingAccounts]));
  return keys.map((date) => {
    const b = byDay.get(date) ?? { compute: 0, llm: 0, other: 0 };
    return {
      date,
      computeUsd: b.compute,
      llmUsd: b.llm,
      otherUsd: b.other,
      totalUsd: b.compute + b.llm + b.other,
      payingAccounts: paying.get(date) ?? 0,
    };
  });
}

/**
 * Sum a numeric field across the days in the trailing `window` of a series.
 * The series is oldest-first, so the trailing window is the tail.
 * `offset` skips that many days off the end first, which is how the
 * "previous 7 days" comparison is built (`offset = 7`).
 */
export function trailingSum<T>(
  series: readonly T[],
  pick: (day: T) => number,
  window: number,
  offset = 0,
): number {
  const end = series.length - offset;
  if (end <= 0) return 0;
  return series.slice(Math.max(0, end - window), end).reduce((sum, d) => sum + pick(d), 0);
}
