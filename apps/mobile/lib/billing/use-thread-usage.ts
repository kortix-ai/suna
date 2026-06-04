import { useQuery } from '@tanstack/react-query';
import { usageApi } from './usage-api';
import type { ThreadUsageResponse, ThreadUsageRecord, UseThreadUsageParams } from './usage-api';

export interface UseThreadUsageOptions extends UseThreadUsageParams {
  enabled?: boolean;
}

export function useThreadUsage({
  limit = 50,
  offset = 0,
  days,
  startDate,
  endDate,
  enabled = true,
}: UseThreadUsageOptions) {
  return useQuery<ThreadUsageResponse>({
    queryKey: ['billing', 'thread-usage', limit, offset, days, startDate?.toISOString(), endDate?.toISOString()],
    queryFn: () => usageApi.getThreadUsage({ limit, offset, days, startDate, endDate }),
    enabled,
    staleTime: 30000, // 30 seconds
  });
}

export type { ThreadUsageResponse, ThreadUsageRecord };

