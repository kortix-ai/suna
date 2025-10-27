/**
 * Models API Hooks
 * 
 * React Query hooks for fetching available models.
 * Following the same patterns as useApiQueries.ts
 */

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { API_URL, getAuthHeaders } from '@/api/config';
import type { AvailableModelsResponse } from '@/api/types';

// ============================================================================
// Query Keys
// ============================================================================

export const modelKeys = {
  all: ['models'] as const,
  available: () => [...modelKeys.all, 'available'] as const,
};

// ============================================================================
// Available Models Hook
// ============================================================================

export function useAvailableModels(
  options?: Omit<UseQueryOptions<AvailableModelsResponse, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: modelKeys.available(),
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_URL}/billing/available-models`, { headers });
      if (!res.ok) throw new Error(`Failed to fetch available models: ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    ...options,
  });
}




