import { API_URL, getAuthHeaders } from '@/api/config';

export interface ThreadUsageRecord {
  thread_id: string;
  project_id: string | null;
  project_name: string;
  credits_used: number;
  last_used: string;
  created_at: string;
}

export interface ThreadUsageResponse {
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

export interface UseThreadUsageParams {
  limit?: number;
  offset?: number;
  days?: number;
  startDate?: Date;
  endDate?: Date;
  enabled?: boolean;
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.detail?.message || error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

export const usageApi = {
  async getThreadUsage({
    limit = 50,
    offset = 0,
    days,
    startDate,
    endDate,
  }: UseThreadUsageParams): Promise<ThreadUsageResponse> {
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
    
    return fetchApi<ThreadUsageResponse>(`/billing/credit-usage-by-thread?${params.toString()}`);
  },
};

