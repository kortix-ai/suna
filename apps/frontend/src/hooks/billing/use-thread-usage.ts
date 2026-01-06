import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { accountStateKeys } from './use-account-state';

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
    period_days: number | null;
    start_date: string;
    end_date: string;
  };
}

interface UseThreadUsageParams {
  limit?: number;
  offset?: number;
  days?: number;
  startDate?: Date;
  endDate?: Date;
}

export function useThreadUsage({
  limit = 50,
  offset = 0,
  days,
  startDate,
  endDate,
}: UseThreadUsageParams) {
  return useQuery<ThreadUsageResponse>({
    queryKey: [...accountStateKeys.all, 'thread-usage', limit, offset, days, startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });
      
      if (startDate && endDate) {
        params.append('start_date', startDate.toISOString());
        params.append('end_date', endDate.toISOString());
      } else if (days) {
        params.append('days', days.toString());
      }
      
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
