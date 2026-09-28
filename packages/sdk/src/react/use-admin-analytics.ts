/**
 * Admin analytics and ARR hooks. The API removed every `/v1/admin/analytics/*`
 * route except `activity` and `usage` (see `use-admin-activity-analytics`).
 * These hooks stay exported until the next major and fail with
 * `ENDPOINT_RETIRED` without sending a request.
 */
import { useRetiredMutation, useRetiredQuery } from './retired-endpoint';

// Analytics source type
export type AnalyticsSource = 'vercel' | 'ga';

// ============================================================================
// TYPES
// ============================================================================

export interface AnalyticsSummary {
  total_users: number;
  total_threads: number;
  active_users_week: number;
  new_signups_today: number;
  new_signups_week: number;
  conversion_rate_week: number;
  avg_threads_per_user: number;
}

export interface ThreadAnalytics {
  thread_id: string;
  project_id?: string | null;
  project_name?: string | null;
  project_category?: string | null;
  account_id: string;
  user_email?: string | null;
  message_count: number;
  user_message_count: number;
  first_user_message?: string | null;
  first_message_summary?: string | null;
  created_at: string;
  updated_at: string;
  is_public: boolean;
}

export interface RetentionData {
  user_id: string;
  email?: string | null;
  first_activity: string;
  last_activity: string;
  total_threads: number;
  weeks_active: number;
  is_recurring: boolean;
}

export interface MessageDistribution {
  distribution: {
    '0_messages': number;
    '1_message': number;
    '2_3_messages': number;
    '5_plus_messages': number;
  };
  total_threads: number;
}

export interface CategoryDistribution {
  distribution: Record<string, number>;
  total_projects: number;
  date: string;
}

export interface TierDistribution {
  distribution: Record<string, number>;
  total_threads: number;
  date: string;
}

export interface VisitorStats {
  total_visitors: number;
  unique_visitors: number;
  pageviews: number;
  date: string;
}

export interface ConversionFunnel {
  visitors: number;
  signups: number;
  subscriptions: number;
  // Breakdown by platform (clickable to see emails)
  web_subscriber_emails: string[];
  app_subscriber_emails: string[];
  visitor_to_signup_rate: number;
  signup_to_subscription_rate: number;
  overall_conversion_rate: number;
  date: string;
}

export interface TranslationResponse {
  original: string;
  translated: string;
  target_language: string;
}

interface PaginationMeta {
  current_page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
}

interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

// ============================================================================
// QUERY PARAMS
// ============================================================================

export interface ThreadBrowseParams {
  page?: number;
  page_size?: number;
  min_messages?: number;
  max_messages?: number;
  search_email?: string;
  category?: string;
  tier?: string;
  date_from?: string;
  date_to?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

export interface RetentionParams {
  page?: number;
  page_size?: number;
  weeks_back?: number;
  min_weeks_active?: number;
}

// ============================================================================
// HOOKS
// ============================================================================

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAnalyticsSummary() {
  return useRetiredQuery<AnalyticsSummary>('useAnalyticsSummary', ['admin', 'analytics', 'summary']);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useThreadBrowser(params: ThreadBrowseParams = {}) {
  return useRetiredQuery<PaginatedResponse<ThreadAnalytics>>('useThreadBrowser', ['admin', 'analytics', 'threads', params]);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useMessageDistribution(dateFrom?: string, dateTo?: string, enabled: boolean = true) {
  return useRetiredQuery<MessageDistribution>('useMessageDistribution', ['admin', 'analytics', 'message-distribution', dateFrom, dateTo], enabled);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useCategoryDistribution(dateFrom?: string, dateTo?: string, tier?: string | null, enabled: boolean = true) {
  return useRetiredQuery<CategoryDistribution>('useCategoryDistribution', ['admin', 'analytics', 'category-distribution', dateFrom, dateTo, tier], enabled);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useTierDistribution(dateFrom?: string, dateTo?: string, enabled: boolean = true) {
  return useRetiredQuery<TierDistribution>('useTierDistribution', ['admin', 'analytics', 'tier-distribution', dateFrom, dateTo], enabled);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useVisitorStats(date?: string, source: AnalyticsSource = 'vercel') {
  return useRetiredQuery<VisitorStats>('useVisitorStats', ['admin', 'analytics', 'visitors', date, source]);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useConversionFunnel(dateFrom?: string, dateTo?: string, source: AnalyticsSource = 'vercel') {
  return useRetiredQuery<ConversionFunnel>('useConversionFunnel', ['admin', 'analytics', 'conversion-funnel', dateFrom, dateTo, source]);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useRetentionData(params: RetentionParams = {}) {
  return useRetiredQuery<PaginatedResponse<RetentionData>>('useRetentionData', ['admin', 'analytics', 'retention', params]);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useTranslate() {
  return useRetiredMutation<TranslationResponse, { text: string; targetLanguage?: string }>('useTranslate');
}


// ============================================================================
// ARR WEEKLY ACTUALS
// ============================================================================

// Tracks which fields have been manually overridden by admin
// When a field is true, its value should NOT be overwritten by Stripe/API data
export interface FieldOverrides {
  views?: boolean;
  signups?: boolean;
  new_paid?: boolean;
  churn?: boolean;
  subscribers?: boolean;
  mrr?: boolean;
  arr?: boolean;
}

export type Platform = 'web' | 'app';

export interface WeeklyActualData {
  week_number: number;
  week_start_date: string;
  platform: Platform;  // 'web' (auto-sync) or 'app' (manual/RevenueCat)
  views: number;
  signups: number;
  new_paid: number;
  churn: number;
  subscribers: number;
  mrr: number;
  arr: number;
  overrides?: FieldOverrides;  // Tracks which fields are locked/manually overridden
}

export interface WeeklyActualsResponse {
  // Key is "{week_number}_{platform}" e.g. "1_web", "1_app"
  actuals: Record<string, WeeklyActualData>;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useARRWeeklyActuals() {
  return useRetiredQuery<WeeklyActualsResponse>('useARRWeeklyActuals', ['admin', 'analytics', 'arr-actuals']);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useUpdateARRWeeklyActual() {
  return useRetiredMutation<WeeklyActualData, WeeklyActualData>('useUpdateARRWeeklyActual');
}

export interface DeleteWeeklyActualParams {
  weekNumber: number;
  platform: Platform;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useDeleteARRWeeklyActual() {
  return useRetiredMutation<{ message: string }, DeleteWeeklyActualParams>('useDeleteARRWeeklyActual');
}

// Toggle override for a specific field in a week
export interface ToggleOverrideParams {
  weekNumber: number;
  platform: Platform;
  field: keyof FieldOverrides;
  override: boolean;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useToggleFieldOverride() {
  return useRetiredMutation<{ message: string }, ToggleOverrideParams>('useToggleFieldOverride');
}

// ============================================================================
// ARR SIMULATOR CONFIG
// ============================================================================

export interface SimulatorConfigData {
  starting_subs: number;
  starting_mrr: number;
  weekly_visitors: number;
  landing_conversion: number;
  signup_to_paid: number;
  arpu: number;
  monthly_churn: number;
  visitor_growth: number;
  target_arr: number;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useARRSimulatorConfig() {
  return useRetiredQuery<SimulatorConfigData>('useARRSimulatorConfig', ['admin', 'analytics', 'arr-config']);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useUpdateARRSimulatorConfig() {
  return useRetiredMutation<SimulatorConfigData, SimulatorConfigData>('useUpdateARRSimulatorConfig');
}

// ============================================================================
// ARR SIGNUPS BY DATE (fetched from database, grouped by frontend)
// ============================================================================

export interface SignupsByDateResponse {
  date_from: string;
  date_to: string;
  signups_by_date: Record<string, number>;  // YYYY-MM-DD -> count
  total: number;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useSignupsByDate(dateFrom: string, dateTo: string) {
  return useRetiredQuery<SignupsByDateResponse>('useSignupsByDate', ['admin', 'analytics', 'signups-by-date', dateFrom, dateTo], !!dateFrom && !!dateTo);
}

// ============================================================================
// ARR VIEWS BY DATE (fetched from Google Analytics, grouped by frontend)
// ============================================================================

export interface ViewsByDateResponse {
  date_from: string;
  date_to: string;
  views_by_date: Record<string, number>;  // YYYY-MM-DD -> count
  total: number;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useViewsByDate(dateFrom: string, dateTo: string, source: AnalyticsSource = 'vercel') {
  return useRetiredQuery<ViewsByDateResponse>('useViewsByDate', ['admin', 'analytics', 'views-by-date', dateFrom, dateTo, source], !!dateFrom && !!dateTo);
}

// ============================================================================
// ARR NEW PAID SUBSCRIPTIONS BY DATE (fetched from Stripe, excludes free tier)
// ============================================================================

export interface NewPaidByDateResponse {
  date_from: string;
  date_to: string;
  new_paid_by_date: Record<string, number>;  // YYYY-MM-DD -> count
  total: number;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useNewPaidByDate(dateFrom: string, dateTo: string) {
  return useRetiredQuery<NewPaidByDateResponse>('useNewPaidByDate', ['admin', 'analytics', 'new-paid-by-date', dateFrom, dateTo], !!dateFrom && !!dateTo);
}

// ============================================================================
// ARR CHURN BY DATE (fetched from Stripe Events, grouped by frontend)
// ============================================================================

export interface ChurnByDateResponse {
  date_from: string;
  date_to: string;
  churn_by_date: Record<string, number>;  // YYYY-MM-DD -> count
  total: number;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useChurnByDate(dateFrom: string, dateTo: string) {
  return useRetiredQuery<ChurnByDateResponse>('useChurnByDate', ['admin', 'analytics', 'churn-by-date', dateFrom, dateTo], !!dateFrom && !!dateTo);
}


// ============================================================================
// ARR MONTHLY ACTUALS (Direct monthly editing with override support)
// ============================================================================

export interface MonthlyActualData {
  month_index: number;  // 0=Dec 2024, 1=Jan 2025, etc.
  month_name: string;   // 'Dec 2024', 'Jan 2025', etc.
  platform: Platform;   // 'web' (auto-sync) or 'app' (manual/RevenueCat)
  views: number;
  signups: number;
  new_paid: number;
  churn: number;
  subscribers: number;
  mrr: number;
  arr: number;
  overrides?: FieldOverrides;  // Tracks which fields are locked/manually overridden
}

export interface MonthlyActualsResponse {
  // Key is "{month_index}_{platform}" e.g. "0_web", "0_app"
  actuals: Record<string, MonthlyActualData>;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useARRMonthlyActuals() {
  return useRetiredQuery<MonthlyActualsResponse>('useARRMonthlyActuals', ['admin', 'analytics', 'arr-monthly-actuals']);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useUpdateARRMonthlyActual() {
  return useRetiredMutation<MonthlyActualData, MonthlyActualData>('useUpdateARRMonthlyActual');
}

export interface DeleteMonthlyActualParams {
  monthIndex: number;
  platform: Platform;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useDeleteARRMonthlyActual() {
  return useRetiredMutation<{ message: string }, DeleteMonthlyActualParams>('useDeleteARRMonthlyActual');
}

// Toggle override for a specific field in a month
export interface ToggleMonthlyOverrideParams {
  monthIndex: number;
  platform: Platform;
  field: keyof FieldOverrides;
  override: boolean;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useToggleMonthlyFieldOverride() {
  return useRetiredMutation<{ message: string }, ToggleMonthlyOverrideParams>('useToggleMonthlyFieldOverride');
}


// ============================================================================
// EXECUTIVE OVERVIEW HOOKS
// ============================================================================

export interface RevenueSummary {
  mrr: number;
  arr: number;
  total_paid_subscribers: number;
  subscribers_by_tier: Record<string, number>;
  arpu: number;
  mrr_change_percent: number | null;
  new_paid_this_month: number;
  churned_this_month: number;
}

export interface EngagementSummary {
  dau: number;
  wau: number;
  mau: number;
  dau_mau_ratio: number;
  avg_threads_per_active_user: number;
  total_threads_today: number;
  total_threads_week: number;
  retention_d1: number | null;
  retention_d7: number | null;
  retention_d30: number | null;
}

export interface TaskPerformance {
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  stopped_runs: number;  // User cancelled
  running_runs: number;
  pending_runs: number;  // Not started yet
  success_rate: number;  // completed / (completed + failed + stopped)
  avg_duration_seconds: number | null;  // Excludes stuck tasks (> 1hr)
  avg_duration_with_stuck_seconds: number | null;  // Includes all tasks
  stuck_task_count: number;  // Tasks with duration > 1hr (likely stuck)
  runs_by_status: Record<string, number>;
}

export interface ToolUsage {
  tool_name: string;
  usage_count: number;
  unique_threads: number;
  percentage_of_threads: number;
}

export interface ToolAdoptionSummary {
  total_tool_calls: number;
  total_threads_with_tools: number;
  top_tools: ToolUsage[];
  tool_adoption_rate: number;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useRevenueSummary() {
  return useRetiredQuery<RevenueSummary>('useRevenueSummary', ['admin', 'analytics', 'revenue-summary']);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useEngagementSummary(dateFrom?: string, dateTo?: string) {
  return useRetiredQuery<EngagementSummary>('useEngagementSummary', ['admin', 'analytics', 'engagement-summary', dateFrom, dateTo]);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useTaskPerformance(dateFrom?: string, dateTo?: string) {
  return useRetiredQuery<TaskPerformance>('useTaskPerformance', ['admin', 'analytics', 'task-performance', dateFrom, dateTo]);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useToolAdoption(date?: string) {
  return useRetiredQuery<ToolAdoptionSummary>('useToolAdoption', ['admin', 'analytics', 'tool-adoption', date]);
}


// ============================================================================
// PROFITABILITY
// ============================================================================

export interface TierProfitability {
  tier: string;
  display_name: string;
  provider: 'stripe' | 'revenuecat';
  payment_count: number;
  unique_users: number;
  usage_users: number;  // Users with LLM usage (from credit_ledger)
  total_revenue: number;
  total_cost: number;
  total_actual_cost: number;
  gross_profit: number;
  gross_margin_percent: number;
  avg_cost_per_user: number;
  avg_revenue_per_user: number;
  avg_profit_per_user: number;
}

export interface ProfitabilitySummary {
  // Overall metrics
  total_revenue: number;
  total_cost: number;
  total_actual_cost: number;
  gross_profit: number;
  gross_margin_percent: number;

  // Breakdown by tier
  by_tier: TierProfitability[];

  // Breakdown by platform
  web_revenue: number;
  web_cost: number;
  web_profit: number;
  app_revenue: number;
  app_cost: number;
  app_profit: number;

  // Per-user averages (industry standard)
  avg_revenue_per_paid_user: number;  // ARPU: revenue / paying users
  avg_cost_per_active_user: number;   // Cost to serve: costs / active users

  // User counts
  unique_paying_users: number;   // Users who made a payment
  unique_active_users: number;   // Users who had usage (including free)
  paying_user_emails: string[];  // Emails of paying users (clickable)

  total_active_subscriptions: number;
  stripe_active_subscriptions: number;
  revenuecat_active_subscriptions: number;

  // Meta
  period_start: string;
  period_end: string;
  total_payments: number;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useProfitability(dateFrom?: string, dateTo?: string) {
  return useRetiredQuery<ProfitabilitySummary>('useProfitability', ['admin', 'analytics', 'profitability', dateFrom, dateTo]);
}
