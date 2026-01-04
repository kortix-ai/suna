'use client';

import { useQuery } from '@tanstack/react-query';
import { checkApiHealth, type HealthCheckResponse } from '@/lib/api/health';
import { healthKeys } from '../files/keys';

export const useApiHealth = (options?) => {
  return useQuery<HealthCheckResponse>({
    queryKey: healthKeys.api(),
    queryFn: checkApiHealth,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 3,
    placeholderData: { status: 'ok', timestamp: '', instance_id: '' },
    ...options,
  });
}; 