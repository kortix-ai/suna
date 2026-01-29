import { backendApi } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';

// ============================================================================
// TYPES
// ============================================================================

export interface ConversationInsight {
  sentiment_distribution: {
    positive: number;
    neutral: number;
    negative: number;
    mixed: number;
  };
  avg_frustration: number;
  feature_request_count: number;
  total_analyzed: number;
  intent_distribution: {
    task: number;
    question: number;
    complaint: number;
    feature_request: number;
  };
}

export interface ConversationAnalyticsItem {
  id: string;
  thread_id: string;
  account_id: string;
  user_email?: string | null;
  sentiment_label?: string | null;
  frustration_score?: number | null;
  frustration_signals: string[];
  intent_type?: string | null;
  is_feature_request: boolean;
  feature_request_text?: string | null;
  first_user_message?: string | null;
  user_message_count?: number | null;
  analyzed_at: string;
}

export interface QueueStatus {
  queue: {
    pending: number;
    processing: number;
    failed: number;
    completed: number;
  };
  total_analyzed: number;
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
// HOOKS
// ============================================================================

export function useConversationInsights(dateFrom?: string, dateTo?: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'conversation-insights', dateFrom, dateTo],
    queryFn: async (): Promise<ConversationInsight> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const queryString = params.toString();
      const url = queryString
        ? `/admin/analytics/conversations/insights?${queryString}`
        : '/admin/analytics/conversations/insights';
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

export function useFrustratedConversations(
  threshold: number = 0.5,
  page: number = 1,
  pageSize: number = 20
) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'frustrated-conversations', threshold, page, pageSize],
    queryFn: async (): Promise<PaginatedResponse<ConversationAnalyticsItem>> => {
      const params = new URLSearchParams();
      params.append('threshold', threshold.toString());
      params.append('page', page.toString());
      params.append('page_size', pageSize.toString());
      const response = await backendApi.get(`/admin/analytics/conversations/frustrated?${params.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 30000, // 30 seconds
    placeholderData: (previousData) => previousData,
  });
}

export function useFeatureRequests(page: number = 1, pageSize: number = 20) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'feature-requests', page, pageSize],
    queryFn: async (): Promise<PaginatedResponse<ConversationAnalyticsItem>> => {
      const params = new URLSearchParams();
      params.append('page', page.toString());
      params.append('page_size', pageSize.toString());
      const response = await backendApi.get(`/admin/analytics/conversations/feature-requests?${params.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 30000, // 30 seconds
    placeholderData: (previousData) => previousData,
  });
}

export function useConversationsBySentiment(
  sentiment: string | null,
  page: number = 1,
  pageSize: number = 20,
  dateFrom?: string,
  dateTo?: string
) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'conversations-by-sentiment', sentiment, page, pageSize, dateFrom, dateTo],
    queryFn: async (): Promise<PaginatedResponse<ConversationAnalyticsItem>> => {
      if (!sentiment) throw new Error('Sentiment is required');
      const params = new URLSearchParams();
      params.append('sentiment', sentiment);
      params.append('page', page.toString());
      params.append('page_size', pageSize.toString());
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const response = await backendApi.get(`/admin/analytics/conversations/by-sentiment?${params.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    enabled: !!sentiment,
    staleTime: 30000,
    placeholderData: (previousData) => previousData,
  });
}

export function useConversationsByIntent(
  intent: string | null,
  page: number = 1,
  pageSize: number = 20,
  dateFrom?: string,
  dateTo?: string
) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'conversations-by-intent', intent, page, pageSize, dateFrom, dateTo],
    queryFn: async (): Promise<PaginatedResponse<ConversationAnalyticsItem>> => {
      if (!intent) throw new Error('Intent is required');
      const params = new URLSearchParams();
      params.append('intent', intent);
      params.append('page', page.toString());
      params.append('page_size', pageSize.toString());
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const response = await backendApi.get(`/admin/analytics/conversations/by-intent?${params.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    enabled: !!intent,
    staleTime: 30000,
    placeholderData: (previousData) => previousData,
  });
}

export function useAnalyticsQueueStatus() {
  return useQuery({
    queryKey: ['admin', 'analytics', 'queue-status'],
    queryFn: async (): Promise<QueueStatus> => {
      const response = await backendApi.get('/admin/analytics/conversations/queue-status');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 10000, // 10 seconds
    refetchInterval: 30000, // Auto-refresh every 30 seconds
  });
}

export function useConversationsByCategory(
  category: string | null,
  page: number = 1,
  pageSize: number = 20,
  dateFrom?: string,
  dateTo?: string
) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'conversations-by-category', category, page, pageSize, dateFrom, dateTo],
    queryFn: async (): Promise<PaginatedResponse<ConversationAnalyticsItem>> => {
      if (!category) throw new Error('Category is required');
      const params = new URLSearchParams();
      params.append('category', category);
      params.append('page', page.toString());
      params.append('page_size', pageSize.toString());
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const response = await backendApi.get(`/admin/analytics/conversations/by-category?${params.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    enabled: !!category,
    staleTime: 30000,
    placeholderData: (previousData) => previousData,
  });
}

// Use case categories - groups by category
export interface UseCluster {
  cluster_id: number;
  label: string;
  count: number;
  examples: Array<{
    thread_id: string;
    account_id: string;
  }>;
}

export interface ClusteredUseCasesResponse {
  clusters: UseCluster[];
  total_clusters: number;
  total_use_cases: number;
  date_from?: string | null;
  date_to?: string | null;
}

export function useClusteredUseCases(
  dateFrom?: string,
  dateTo?: string,
  distanceThreshold: number = 0.3
) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'clustered-use-cases', dateFrom, dateTo, distanceThreshold],
    queryFn: async (): Promise<ClusteredUseCasesResponse> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      params.append('distance_threshold', distanceThreshold.toString());
      const response = await backendApi.get(
        `/admin/analytics/conversations/use-cases/clustered?${params.toString()}`
      );
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000, // 1 minute
    placeholderData: (previousData) => previousData,
  });
}
