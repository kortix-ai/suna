import { backendApi } from '@/lib/api-client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
  subscriber_emails: string[];  // Emails of new paid subscribers for this date
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

export function useAnalyticsSummary() {
  return useQuery({
    queryKey: ['admin', 'analytics', 'summary'],
    queryFn: async (): Promise<AnalyticsSummary> => {
      const response = await backendApi.get('/admin/analytics/summary');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
  });
}

export function useThreadBrowser(params: ThreadBrowseParams = {}) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'threads', params],
    queryFn: async (): Promise<PaginatedResponse<ThreadAnalytics>> => {
      const searchParams = new URLSearchParams();
      
      if (params.page) searchParams.append('page', params.page.toString());
      if (params.page_size) searchParams.append('page_size', params.page_size.toString());
      if (params.min_messages !== undefined) searchParams.append('min_messages', params.min_messages.toString());
      if (params.max_messages !== undefined) searchParams.append('max_messages', params.max_messages.toString());
      if (params.search_email) searchParams.append('search_email', params.search_email);
      if (params.category) searchParams.append('category', params.category);
      if (params.tier) searchParams.append('tier', params.tier);
      if (params.date_from) searchParams.append('date_from', params.date_from);
      if (params.date_to) searchParams.append('date_to', params.date_to);
      if (params.sort_by) searchParams.append('sort_by', params.sort_by);
      if (params.sort_order) searchParams.append('sort_order', params.sort_order);
      
      const response = await backendApi.get(`/admin/analytics/threads/browse?${searchParams.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 30000, // 30 seconds
  });
}

export function useMessageDistribution(dateFrom?: string, dateTo?: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'message-distribution', dateFrom, dateTo],
    queryFn: async (): Promise<MessageDistribution> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const queryString = params.toString();
      const url = queryString
        ? `/admin/analytics/threads/message-distribution?${queryString}`
        : '/admin/analytics/threads/message-distribution';
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
    placeholderData: (previousData) => previousData, // Keep previous data while loading
    enabled,
  });
}

export function useCategoryDistribution(dateFrom?: string, dateTo?: string, tier?: string | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'category-distribution', dateFrom, dateTo, tier],
    queryFn: async (): Promise<CategoryDistribution> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      if (tier) params.append('tier', tier);
      const queryString = params.toString();
      const url = queryString
        ? `/admin/analytics/projects/category-distribution?${queryString}`
        : '/admin/analytics/projects/category-distribution';
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
    placeholderData: (previousData) => previousData,
    enabled,
  });
}

export function useTierDistribution(dateFrom?: string, dateTo?: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'tier-distribution', dateFrom, dateTo],
    queryFn: async (): Promise<TierDistribution> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const queryString = params.toString();
      const url = queryString
        ? `/admin/analytics/threads/tier-distribution?${queryString}`
        : '/admin/analytics/threads/tier-distribution';
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
    placeholderData: (previousData) => previousData,
    enabled,
  });
}

export function useVisitorStats(date?: string, source: AnalyticsSource = 'vercel') {
  return useQuery({
    queryKey: ['admin', 'analytics', 'visitors', date, source],
    queryFn: async (): Promise<VisitorStats> => {
      const params = new URLSearchParams();
      if (date) params.append('date', date);
      params.append('source', source);
      const url = `/admin/analytics/visitors?${params.toString()}`;
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
    placeholderData: (previousData) => previousData,
    retry: 1,
  });
}

export function useConversionFunnel(dateFrom?: string, dateTo?: string, source: AnalyticsSource = 'vercel') {
  return useQuery({
    queryKey: ['admin', 'analytics', 'conversion-funnel', dateFrom, dateTo, source],
    queryFn: async (): Promise<ConversionFunnel> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      params.append('source', source);
      const url = `/admin/analytics/conversion-funnel?${params.toString()}`;
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
    placeholderData: (previousData) => previousData,
    retry: 1,
  });
}

export function useRetentionData(params: RetentionParams = {}) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'retention', params],
    queryFn: async (): Promise<PaginatedResponse<RetentionData>> => {
      const searchParams = new URLSearchParams();
      
      if (params.page) searchParams.append('page', params.page.toString());
      if (params.page_size) searchParams.append('page_size', params.page_size.toString());
      if (params.weeks_back) searchParams.append('weeks_back', params.weeks_back.toString());
      if (params.min_weeks_active) searchParams.append('min_weeks_active', params.min_weeks_active.toString());
      
      const response = await backendApi.get(`/admin/analytics/retention?${searchParams.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
  });
}

export function useTranslate() {
  return useMutation({
    mutationFn: async ({ text, targetLanguage = 'English' }: { text: string; targetLanguage?: string }): Promise<TranslationResponse> => {
      const response = await backendApi.post('/admin/analytics/translate', {
        text,
        target_language: targetLanguage
      });
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
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

export function useARRWeeklyActuals() {
  return useQuery({
    queryKey: ['admin', 'analytics', 'arr-actuals'],
    queryFn: async (): Promise<WeeklyActualsResponse> => {
      const response = await backendApi.get('/admin/analytics/arr/actuals');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
  });
}

export function useUpdateARRWeeklyActual() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: WeeklyActualData): Promise<WeeklyActualData> => {
      const platform = data.platform || 'web';
      const response = await backendApi.put(`/admin/analytics/arr/actuals/${data.week_number}?platform=${platform}`, data);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'arr-actuals'] });
    },
  });
}

export interface DeleteWeeklyActualParams {
  weekNumber: number;
  platform: Platform;
}

export function useDeleteARRWeeklyActual() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ weekNumber, platform }: DeleteWeeklyActualParams): Promise<{ message: string }> => {
      const response = await backendApi.delete(`/admin/analytics/arr/actuals/${weekNumber}?platform=${platform}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'arr-actuals'] });
    },
  });
}

// Toggle override for a specific field in a week
export interface ToggleOverrideParams {
  weekNumber: number;
  platform: Platform;
  field: keyof FieldOverrides;
  override: boolean;
}

export function useToggleFieldOverride() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ weekNumber, platform, field, override }: ToggleOverrideParams): Promise<{ message: string }> => {
      const response = await backendApi.patch(`/admin/analytics/arr/actuals/${weekNumber}/override?platform=${platform}`, {
        field,
        override,
      });
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'arr-actuals'] });
    },
  });
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

export function useARRSimulatorConfig() {
  return useQuery({
    queryKey: ['admin', 'analytics', 'arr-config'],
    queryFn: async (): Promise<SimulatorConfigData> => {
      const response = await backendApi.get('/admin/analytics/arr/config');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
  });
}

export function useUpdateARRSimulatorConfig() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: SimulatorConfigData): Promise<SimulatorConfigData> => {
      const response = await backendApi.put('/admin/analytics/arr/config', data);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'arr-config'] });
    },
  });
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

export function useSignupsByDate(dateFrom: string, dateTo: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'signups-by-date', dateFrom, dateTo],
    queryFn: async (): Promise<SignupsByDateResponse> => {
      const response = await backendApi.get(
        `/admin/analytics/arr/signups?date_from=${dateFrom}&date_to=${dateTo}`
      );
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    enabled: !!dateFrom && !!dateTo,
  });
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

export function useViewsByDate(dateFrom: string, dateTo: string, source: AnalyticsSource = 'vercel') {
  return useQuery({
    queryKey: ['admin', 'analytics', 'views-by-date', dateFrom, dateTo, source],
    queryFn: async (): Promise<ViewsByDateResponse> => {
      const response = await backendApi.get(
        `/admin/analytics/arr/views?date_from=${dateFrom}&date_to=${dateTo}&source=${source}`
      );
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    enabled: !!dateFrom && !!dateTo,
    retry: 1,
  });
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

export function useNewPaidByDate(dateFrom: string, dateTo: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'new-paid-by-date', dateFrom, dateTo],
    queryFn: async (): Promise<NewPaidByDateResponse> => {
      const response = await backendApi.get(
        `/admin/analytics/arr/new-paid?date_from=${dateFrom}&date_to=${dateTo}`
      );
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    enabled: !!dateFrom && !!dateTo,
    retry: 1,
  });
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

export function useChurnByDate(dateFrom: string, dateTo: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'churn-by-date', dateFrom, dateTo],
    queryFn: async (): Promise<ChurnByDateResponse> => {
      const response = await backendApi.get(
        `/admin/analytics/arr/churn?date_from=${dateFrom}&date_to=${dateTo}`
      );
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    enabled: !!dateFrom && !!dateTo,
    retry: 1,
  });
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

export function useARRMonthlyActuals() {
  return useQuery({
    queryKey: ['admin', 'analytics', 'arr-monthly-actuals'],
    queryFn: async (): Promise<MonthlyActualsResponse> => {
      const response = await backendApi.get('/admin/analytics/arr/monthly-actuals');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
  });
}

export function useUpdateARRMonthlyActual() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: MonthlyActualData): Promise<MonthlyActualData> => {
      const platform = data.platform || 'web';
      const response = await backendApi.put(`/admin/analytics/arr/monthly-actuals/${data.month_index}?platform=${platform}`, data);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'arr-monthly-actuals'] });
    },
  });
}

export interface DeleteMonthlyActualParams {
  monthIndex: number;
  platform: Platform;
}

export function useDeleteARRMonthlyActual() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ monthIndex, platform }: DeleteMonthlyActualParams): Promise<{ message: string }> => {
      const response = await backendApi.delete(`/admin/analytics/arr/monthly-actuals/${monthIndex}?platform=${platform}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'arr-monthly-actuals'] });
    },
  });
}

// Toggle override for a specific field in a month
export interface ToggleMonthlyOverrideParams {
  monthIndex: number;
  platform: Platform;
  field: keyof FieldOverrides;
  override: boolean;
}

export function useToggleMonthlyFieldOverride() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ monthIndex, platform, field, override }: ToggleMonthlyOverrideParams): Promise<{ message: string }> => {
      const response = await backendApi.patch(`/admin/analytics/arr/monthly-actuals/${monthIndex}/override?platform=${platform}`, {
        field,
        override,
      });
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'arr-monthly-actuals'] });
    },
  });
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
  avg_duration_seconds: number | null;
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

export function useRevenueSummary() {
  return useQuery({
    queryKey: ['admin', 'analytics', 'revenue-summary'],
    queryFn: async (): Promise<RevenueSummary> => {
      const response = await backendApi.get('/admin/analytics/revenue-summary');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    retry: 1,
  });
}

export function useEngagementSummary(dateFrom?: string, dateTo?: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'engagement-summary', dateFrom, dateTo],
    queryFn: async (): Promise<EngagementSummary> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const queryString = params.toString();
      const url = queryString
        ? `/admin/analytics/engagement-summary?${queryString}`
        : '/admin/analytics/engagement-summary';
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    placeholderData: (previousData) => previousData,
  });
}

export function useTaskPerformance(dateFrom?: string, dateTo?: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'task-performance', dateFrom, dateTo],
    queryFn: async (): Promise<TaskPerformance> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const queryString = params.toString();
      const url = queryString
        ? `/admin/analytics/task-performance?${queryString}`
        : '/admin/analytics/task-performance';
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    placeholderData: (previousData) => previousData,
  });
}

export function useToolAdoption(date?: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'tool-adoption', date],
    queryFn: async (): Promise<ToolAdoptionSummary> => {
      const url = date
        ? `/admin/analytics/tool-adoption?date=${date}`
        : '/admin/analytics/tool-adoption';
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    placeholderData: (previousData) => previousData,
  });
}
