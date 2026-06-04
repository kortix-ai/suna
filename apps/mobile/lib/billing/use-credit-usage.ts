import { useQuery } from '@tanstack/react-query';
import { API_URL, getAuthHeaders } from '@/api/config';

interface UsageRecord {
  id: string;
  created_at: string;
  credits_used: number;
  balance_after: number;
  type: string;
  description: string;
  metadata: Record<string, any>;
}

interface UsageResponse {
  usage_records: UsageRecord[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
  summary: {
    total_credits_used: number;
    period_days: number;
    since_date: string;
  };
}

export function useCreditUsage(
  limit: number = 50,
  offset: number = 0,
  days: number = 30
) {
  return useQuery<UsageResponse>({
    queryKey: ['billing', 'credit-usage', limit, offset, days],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
        days: days.toString(),
      });
      
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/billing/credit-usage?${params.toString()}`, {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(error.detail?.message || error.message || `HTTP ${response.status}`);
      }
      
      return response.json();
    },
    staleTime: 30000,
  });
}

export type { UsageRecord, UsageResponse };

