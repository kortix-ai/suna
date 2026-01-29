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
  avg_churn_risk: number;
  top_topics: Array<{ topic: string; count: number }>;
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
  sentiment_score?: number | null;
  sentiment_label?: string | null;
  frustration_score?: number | null;
  frustration_signals: string[];
  churn_risk_score?: number | null;
  churn_signals: string[];
  primary_topic?: string | null;
  intent_type?: string | null;
  is_feature_request: boolean;
  feature_request_text?: string | null;
  user_message_count?: number | null;
  analyzed_at: string;
}

export interface TopicDistribution {
  distribution: Record<string, number>;
  total: number;
  date_from?: string | null;
  date_to?: string | null;
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

export function useChurnRiskConversations(
  threshold: number = 0.7,
  page: number = 1,
  pageSize: number = 20
) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'churn-risk-conversations', threshold, page, pageSize],
    queryFn: async (): Promise<PaginatedResponse<ConversationAnalyticsItem>> => {
      const params = new URLSearchParams();
      params.append('threshold', threshold.toString());
      params.append('page', page.toString());
      params.append('page_size', pageSize.toString());
      const response = await backendApi.get(`/admin/analytics/conversations/churn-risk?${params.toString()}`);
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

export function useTopicDistribution(dateFrom?: string, dateTo?: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'topic-distribution', dateFrom, dateTo],
    queryFn: async (): Promise<TopicDistribution> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const queryString = params.toString();
      const url = queryString
        ? `/admin/analytics/conversations/topics?${queryString}`
        : '/admin/analytics/conversations/topics';
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

// Use case patterns - what users are actually doing
export interface UseCasePatterns {
  top_use_cases: Array<{ use_case: string; count: number }>;
  output_types: Record<string, number>;
  domains: Record<string, number>;
  top_keywords: Array<{ keyword: string; count: number }>;
  total: number;
  date_from?: string | null;
  date_to?: string | null;
}

export function useUseCasePatterns(dateFrom?: string, dateTo?: string) {
  return useQuery({
    queryKey: ['admin', 'analytics', 'use-case-patterns', dateFrom, dateTo],
    queryFn: async (): Promise<UseCasePatterns> => {
      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      const queryString = params.toString();
      const url = queryString
        ? `/admin/analytics/conversations/use-cases?${queryString}`
        : '/admin/analytics/conversations/use-cases';
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

// Clustered use cases - groups similar use cases by semantic similarity
export interface UseCluster {
  cluster_id: number;
  label: string;
  count: number;
  use_cases: string[];
  examples: Array<{
    use_case_summary: string;
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
