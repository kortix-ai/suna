import { backendApi } from '@/lib/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';

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

interface FeedbackStats {
  total_feedback: number;
  average_rating: number;
  total_with_text: number;
  rating_distribution: Record<string, number>;
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
  };
}

