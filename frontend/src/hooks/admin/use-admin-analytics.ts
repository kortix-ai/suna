import { backendApi } from '@/lib/api-client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// ============================================================================
// TYPES
// ============================================================================

export interface AnalyticsSummary {
  total_users: number;
  total_threads: number;
  total_messages: number;
  active_users_today: number;
  active_users_week: number;
  new_signups_today: number;
  new_signups_week: number;
  new_subscriptions_today: number;
  new_subscriptions_week: number;
  conversion_rate_today: number;
  conversion_rate_week: number;
  avg_messages_per_thread: number;
  avg_threads_per_user: number;
}

export interface DailyStats {
  date: string;
  signups: number;
  subscriptions: number;
  threads_created: number;
  active_users: number;
  conversion_rate: number;
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

export function useDailyStats(days: number = 30) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'daily', days],
    queryFn: async (): Promise<DailyStats[]> => {
      const response = await backendApi.get(`/admin/analytics/daily?days=${days}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
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

export function useMessageDistribution(date?: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'message-distribution', date],
    queryFn: async (): Promise<MessageDistribution> => {
      const url = date
        ? `/admin/analytics/threads/message-distribution?date=${date}`
        : '/admin/analytics/threads/message-distribution';
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
    placeholderData: (previousData) => previousData, // Keep previous data while loading
  });
}

export function useCategoryDistribution(date?: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'category-distribution', date],
    queryFn: async (): Promise<CategoryDistribution> => {
      const url = date
        ? `/admin/analytics/projects/category-distribution?date=${date}`
        : '/admin/analytics/projects/category-distribution';
      const response = await backendApi.get(url);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000, // 5 minutes
    placeholderData: (previousData) => previousData,
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

export function useRefreshAnalytics() {
  const queryClient = useQueryClient();
  
  return {
    refreshAll: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics'] });
    },
    refreshSummary: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'summary'] });
    },
    refreshDaily: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'daily'] });
    },
    refreshThreads: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'threads'] });
    },
    refreshRetention: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'analytics', 'retention'] });
    },
  };
}

