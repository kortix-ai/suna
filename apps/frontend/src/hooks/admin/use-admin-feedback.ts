import { backendApi } from '@/lib/api-client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface FeedbackWithUser {
  feedback_id: string;
  account_id: string;
  user_email: string;
  rating: number;
  feedback_text?: string | null;
  help_improve: boolean;
  thread_id?: string | null;
  message_id?: string | null;
  context?: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

interface PaginationMeta {
  current_page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
  next_cursor?: string | null;
  previous_cursor?: string | null;
}

interface FeedbackListResponse {
  data: FeedbackWithUser[];
  pagination: PaginationMeta;
}

interface FeedbackListParams {
  page?: number;
  page_size?: number;
  rating_filter?: number;
  has_text?: boolean;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

export interface FeedbackStats {
  total_feedback: number;
  average_rating: number;
  total_with_text: number;
  rating_distribution: Record<string, number>;
}

export interface SentimentSummary {
  total: number;
  positive: number;
  neutral: number;
  negative: number;
  five_star: number;
  critical: number;
  positive_percentage: number;
  negative_percentage: number;
}

export interface TimeSeriesPoint {
  period: string;
  count: number;
  avg_rating: number;
  positive_count: number;
  negative_count: number;
  with_text_count: number;
}

export interface RatingTrends {
  periods: string[];
  data: Record<string, Record<string, number>>;
}

export interface CriticalFeedback {
  feedback_id: string;
  rating: number;
  feedback_text: string;
  created_at: string;
  thread_id?: string | null;
  user_email: string;
}

export interface ImprovementArea {
  area: string;
  severity: 'high' | 'medium' | 'low';
  frequency: string;
  user_quotes: string[];
  suggested_action: string;
}

export interface ActionableRecommendation {
  recommendation: string;
  priority: 'high' | 'medium' | 'low';
  effort: 'small' | 'medium' | 'large';
  impact: string;
  implementation_hint: string;
}

export interface LLMAnalysisResponse {
  analysis: string;
  key_themes: string[];
  improvement_areas: ImprovementArea[];
  positive_highlights: string[];
  actionable_recommendations: ActionableRecommendation[];
  feedback_analyzed_count: number;
  generated_at: string;
}

export interface LLMAnalysisRequest {
  focus_area?: 'negative' | 'positive' | 'all' | 'critical';
  days?: number;
  max_feedback?: number;
}

export function useAdminFeedbackList(params: FeedbackListParams = {}) {
  return useQuery({
    queryKey: ['admin', 'feedback', 'list', params],
    queryFn: async (): Promise<FeedbackListResponse> => {
      const searchParams = new URLSearchParams();
      
      if (params.page) searchParams.append('page', params.page.toString());
      if (params.page_size) searchParams.append('page_size', params.page_size.toString());
      if (params.rating_filter !== undefined) searchParams.append('rating_filter', params.rating_filter.toString());
      if (params.has_text !== undefined) searchParams.append('has_text', params.has_text.toString());
      if (params.sort_by) searchParams.append('sort_by', params.sort_by);
      if (params.sort_order) searchParams.append('sort_order', params.sort_order);
      
      const response = await backendApi.get(`/admin/feedback/list?${searchParams.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 30000,
  });
}

export function useAdminFeedbackStats() {
  return useQuery({
    queryKey: ['admin', 'feedback', 'stats'],
    queryFn: async (): Promise<FeedbackStats> => {
      const response = await backendApi.get('/admin/feedback/stats');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000,
  });
}

export function useAdminSentimentSummary() {
  return useQuery({
    queryKey: ['admin', 'feedback', 'sentiment'],
    queryFn: async (): Promise<SentimentSummary> => {
      const response = await backendApi.get('/admin/feedback/sentiment');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000,
  });
}

export function useAdminFeedbackTimeSeries(days: number = 30, granularity: string = 'day') {
  return useQuery({
    queryKey: ['admin', 'feedback', 'time-series', days, granularity],
    queryFn: async (): Promise<TimeSeriesPoint[]> => {
      const response = await backendApi.get(`/admin/feedback/time-series?days=${days}&granularity=${granularity}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000,
  });
}

export function useAdminRatingTrends(days: number = 30) {
  return useQuery({
    queryKey: ['admin', 'feedback', 'rating-trends', days],
    queryFn: async (): Promise<RatingTrends> => {
      const response = await backendApi.get(`/admin/feedback/rating-trends?days=${days}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000,
  });
}

export function useAdminCriticalFeedback(limit: number = 20) {
  return useQuery({
    queryKey: ['admin', 'feedback', 'critical', limit],
    queryFn: async (): Promise<CriticalFeedback[]> => {
      const response = await backendApi.get(`/admin/feedback/critical?limit=${limit}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 60000,
  });
}

export function useAdminFeedbackExport(params: {
  rating_filter?: number;
  has_text?: boolean;
  start_date?: string;
  end_date?: string;
}) {
  return useQuery({
    queryKey: ['admin', 'feedback', 'export', params],
    queryFn: async (): Promise<FeedbackWithUser[]> => {
      const searchParams = new URLSearchParams();
      
      if (params.rating_filter !== undefined) searchParams.append('rating_filter', params.rating_filter.toString());
      if (params.has_text !== undefined) searchParams.append('has_text', params.has_text.toString());
      if (params.start_date) searchParams.append('start_date', params.start_date);
      if (params.end_date) searchParams.append('end_date', params.end_date);
      
      const response = await backendApi.get(`/admin/feedback/export?${searchParams.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    enabled: false,
    staleTime: 0,
  });
}

export function useAdminFeedbackAnalysis() {
  return useMutation({
    mutationFn: async (request: LLMAnalysisRequest): Promise<LLMAnalysisResponse> => {
      const response = await backendApi.post('/admin/feedback/analyze', request);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
}

export function useRefreshFeedbackData() {
  const queryClient = useQueryClient();
  
  return {
    refreshFeedbackList: (params?: FeedbackListParams) => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'feedback', 'list'],
      });
    },
    refreshFeedbackStats: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'feedback', 'stats'],
      });
    },
    refreshAll: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'feedback'],
      });
    },
  };
}
