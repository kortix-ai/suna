import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

interface ThreadUsageRecord {
  thread_id: string;
  project_id: string | null;
  project_name: string;
  credits_used: number;
  last_used: string;
  created_at: string;
}

interface ThreadUsageResponse {
  thread_usage: ThreadUsageRecord[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
  summary: {
    total_credits_used: number;
    total_threads: number;
    period_days: number;
    since_date: string;
  };
}

export function useThreadUsage(
  limit: number = 50,
  offset: number = 0,
  days: number = 30
) {
  return useQuery<ThreadUsageResponse>({
    queryKey: ['billing', 'thread-usage', limit, offset, days],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
        days: days.toString(),
      });
      
      const response = await backendApi.get(`/billing/credit-usage-by-thread?${params.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 30000,
  });
}

export type { ThreadUsageRecord, ThreadUsageResponse };

