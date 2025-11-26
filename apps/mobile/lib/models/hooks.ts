/**
 * Models API Hooks
 * 
 * React Query hooks for fetching available models.
 * Following the same patterns as useApiQueries.ts
 */

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { API_URL, getAuthHeaders } from '@/api/config';
import type { AvailableModelsResponse } from '@/api/types';
import { useAuthContext } from '@/contexts/AuthContext';

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
  options?: Omit<UseQueryOptions<AvailableModelsResponse, Error>, 'queryKey' | 'queryFn' | 'enabled'>
) {
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  
  return useQuery({
    queryKey: modelKeys.available(),
    queryFn: async () => {
      console.log('🔄 [useAvailableModels] Fetching available models...');
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_URL}/billing/available-models`, { headers });
      
      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error');
        console.error('❌ [useAvailableModels] Failed to fetch models:', res.status, errorText);
        throw new Error(`Failed to fetch available models: ${res.status} - ${errorText}`);
      }
      
      const data = await res.json();
      console.log('✅ [useAvailableModels] Models fetched:', {
        total: data.models?.length || 0,
        modelIds: data.models?.map((m: any) => m.id) || [],
      });
      
      return data;
    },
    enabled: isAuthenticated && !authLoading, // Only fetch when authenticated
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: (failureCount, error: any) => {
      // Don't retry on 401 errors (unauthorized)
      if (error?.message?.includes('401')) return false;
      return failureCount < 2;
    },
    ...options,
  });
}




