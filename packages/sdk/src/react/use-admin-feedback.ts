/**
 * Admin feedback hooks. The API removed every `/v1/admin/feedback/*` route.
 * These hooks stay exported until the next major and fail with
 * `ENDPOINT_RETIRED` without sending a request.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRetiredMutation, useRetiredQuery } from './retired-endpoint';

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
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

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface FeedbackStats {
  total_feedback: number;
  average_rating: number;
  total_with_text: number;
  rating_distribution: Record<string, number>;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
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

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface TimeSeriesPoint {
  period: string;
  count: number;
  avg_rating: number;
  positive_count: number;
  negative_count: number;
  with_text_count: number;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface RatingTrends {
  periods: string[];
  data: Record<string, Record<string, number>>;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface CriticalFeedback {
  feedback_id: string;
  rating: number;
  feedback_text: string;
  created_at: string;
  thread_id?: string | null;
  user_email: string;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface ImprovementArea {
  area: string;
  severity: 'high' | 'medium' | 'low';
  frequency: string;
  user_quotes: string[];
  suggested_action: string;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface ActionableRecommendation {
  recommendation: string;
  priority: 'high' | 'medium' | 'low';
  effort: 'small' | 'medium' | 'large';
  impact: string;
  implementation_hint: string;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface LLMAnalysisResponse {
  analysis: string;
  key_themes: string[];
  improvement_areas: ImprovementArea[];
  positive_highlights: string[];
  actionable_recommendations: ActionableRecommendation[];
  feedback_analyzed_count: number;
  generated_at: string;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface LLMAnalysisRequest {
  focus_area?: 'negative' | 'positive' | 'all' | 'critical';
  days?: number;
  max_feedback?: number;
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminFeedbackList(params: FeedbackListParams = {}) {
  return useRetiredQuery<FeedbackListResponse>('useAdminFeedbackList', ['admin', 'feedback', 'list', params]);
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminFeedbackStats() {
  return useRetiredQuery<FeedbackStats>('useAdminFeedbackStats', ['admin', 'feedback', 'stats']);
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminSentimentSummary() {
  return useRetiredQuery<SentimentSummary>('useAdminSentimentSummary', ['admin', 'feedback', 'sentiment']);
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminFeedbackTimeSeries(days: number = 30, granularity: string = 'day') {
  return useRetiredQuery<TimeSeriesPoint[]>('useAdminFeedbackTimeSeries', ['admin', 'feedback', 'time-series', days, granularity]);
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminRatingTrends(days: number = 30) {
  return useRetiredQuery<RatingTrends>('useAdminRatingTrends', ['admin', 'feedback', 'rating-trends', days]);
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminCriticalFeedback(limit: number = 20) {
  return useRetiredQuery<CriticalFeedback[]>('useAdminCriticalFeedback', ['admin', 'feedback', 'critical', limit]);
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminFeedbackExport(params: {
  rating_filter?: number;
  has_text?: boolean;
  start_date?: string;
  end_date?: string;
}) {
  return useRetiredQuery<FeedbackWithUser[]>('useAdminFeedbackExport', ['admin', 'feedback', 'export', params], false);
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminFeedbackAnalysis() {
  return useRetiredMutation<LLMAnalysisResponse, LLMAnalysisRequest>('useAdminFeedbackAnalysis');
}

/** @deprecated Invalidates the retired admin feedback queries only. Removed in the next major. */
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
