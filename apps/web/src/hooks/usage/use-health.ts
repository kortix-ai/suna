'use client';

import { useQuery } from '@tanstack/react-query';
import { checkApiHealth, type HealthCheckResponse } from '@/lib/api/health';
// Health keys — standalone definition (legacy keys file was removed)
const healthKeys = {
  all: ['health'] as const,
  api: () => ['health', 'api'] as const,
};

export const useApiHealth = (options?: any) => {
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