/**
 * Admin activity analytics — "how active are our users?".
 *
 * Two read hooks over the platform-admin routes in
 * `apps/api/src/admin/analytics.ts`, which own the response contract:
 *   GET /admin/analytics/activity?days=  -> sessions, active accounts/users, DAU/WAU/MAU
 *   GET /admin/analytics/usage?days=     -> daily credit burn + paying accounts
 *
 * Deliberately a NEW file rather than an addition to `use-admin-analytics.ts`.
 * That module is a large legacy surface bound to an older `/admin/analytics/*`
 * shape (ARR simulator, retention, thread browser) that the current backend does
 * not serve. Nothing there is removed — every export stays public API — but new
 * work does not extend it.
 *
 * Both routes are gated by supabaseAuth + requireAdmin on the server. These
 * hooks do not re-check the caller's role; a non-admin gets a rejected query,
 * which is the correct place for that decision to live.
 */
import { useQuery } from '@tanstack/react-query';

import { backendApi } from '../core/http/api-client';

/** Default series length, matching the API default. */
export const ADMIN_ANALYTICS_DEFAULT_DAYS = 30;
/** Longest series the API will return. Larger values are clamped, not rejected. */
export const ADMIN_ANALYTICS_MAX_DAYS = 90;
/** Shortest series the API will return (today only). */
export const ADMIN_ANALYTICS_MIN_DAYS = 1;

/** One UTC day of platform activity. */
export interface AdminActivityDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** Rows created in `kortix.project_sessions` that day. */
  sessionsCreated: number;
  /** Distinct accounts that created at least one session that day. */
  activeAccounts: number;
  /** Distinct `project_sessions.created_by` users that created a session that day. */
  activeUsers: number;
  /** Accounts created that day. */
  newAccounts: number;
  /** Distinct projects that had a session created in them that day. */
  activeProjects: number;
}

/** Fixed-window headline numbers. These do NOT vary with the requested `days`. */
export interface AdminActivitySummary {
  /** Sessions created in the last 24h * 7. */
  sessionsLast7d: number;
  /** Sessions created in the 7 days before that — the comparison for growth. */
  sessionsPrev7d: number;
  /** Distinct users who created a session in the last 24 hours. */
  dau: number;
  /** ...in the last 7 days. */
  wau: number;
  /** ...in the last 30 days. */
  mau: number;
  totalAccounts: number;
  totalProjects: number;
}

export interface AdminActivityAnalytics {
  days: AdminActivityDay[];
  summary: AdminActivitySummary;
}

/** One UTC day of credit burn. All amounts are positive USD magnitudes. */
export interface AdminUsageDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  computeUsd: number;
  llmUsd: number;
  /** Debits that are neither compute nor LLM — tool calls, manual adjustments. */
  otherUsd: number;
  /** Always exactly `computeUsd + llmUsd + otherUsd`. */
  totalUsd: number;
  /** Distinct accounts with at least one debit that day. */
  payingAccounts: number;
}

export interface AdminUsageSummary {
  /** Totals across the whole requested window, so these DO vary with `days`. */
  totalUsd: number;
  computeUsd: number;
  llmUsd: number;
  otherUsd: number;
  spendLast7d: number;
  spendPrev7d: number;
  /**
   * Distinct accounts that spent in the last 7 days. Counted over the whole
   * window server-side, not summed from `days[].payingAccounts` — an account
   * that spends on three days appears in three daily buckets.
   */
  payingAccountsLast7d: number;
}

export interface AdminUsageAnalytics {
  days: AdminUsageDay[];
  summary: AdminUsageSummary;
}

/**
 * Clamp a requested window to the range the API accepts.
 *
 * Applied to the query KEY as well as the request, so `days=9999` and `days=90`
 * share one cache entry instead of refetching identical data under two keys.
 * Fractional input is truncated for the same reason.
 */
export function clampAdminAnalyticsDays(days?: number): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return ADMIN_ANALYTICS_DEFAULT_DAYS;
  const truncated = Math.trunc(days);
  if (truncated < ADMIN_ANALYTICS_MIN_DAYS) return ADMIN_ANALYTICS_MIN_DAYS;
  if (truncated > ADMIN_ANALYTICS_MAX_DAYS) return ADMIN_ANALYTICS_MAX_DAYS;
  return truncated;
}

// Activity moves on the scale of minutes, and the page is a dashboard an
// operator leaves open. One minute of staleness beats a refetch storm.
const ANALYTICS_STALE_TIME_MS = 60_000;

/**
 * Daily platform activity + DAU/WAU/MAU for the trailing `days` UTC days.
 *
 * `placeholderData` holds the previous window on screen while a new one loads,
 * so changing the range re-renders the charts with new data instead of
 * collapsing them to a skeleton.
 */
export function useAdminActivityAnalytics(days: number = ADMIN_ANALYTICS_DEFAULT_DAYS) {
  const window = clampAdminAnalyticsDays(days);
  return useQuery<AdminActivityAnalytics>({
    queryKey: ['admin', 'analytics', 'activity', window],
    queryFn: async () => {
      const response = await backendApi.get<AdminActivityAnalytics>(
        `/admin/analytics/activity?days=${window}`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: ANALYTICS_STALE_TIME_MS,
    placeholderData: (previousData) => previousData,
  });
}

/** Daily credit burn + paying accounts for the trailing `days` UTC days. */
export function useAdminUsageAnalytics(days: number = ADMIN_ANALYTICS_DEFAULT_DAYS) {
  const window = clampAdminAnalyticsDays(days);
  return useQuery<AdminUsageAnalytics>({
    queryKey: ['admin', 'analytics', 'usage', window],
    queryFn: async () => {
      const response = await backendApi.get<AdminUsageAnalytics>(
        `/admin/analytics/usage?days=${window}`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: ANALYTICS_STALE_TIME_MS,
    placeholderData: (previousData) => previousData,
  });
}
