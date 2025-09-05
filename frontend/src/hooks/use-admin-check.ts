'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';

export function useAdminCheck() {
  const { user } = useAuth();
  
  return useQuery({
    queryKey: ['admin-check', user?.id],
    queryFn: async () => {
      try {
        const response = await apiClient.request('/api/enterprise/check-admin');
        return response.data?.is_admin || false;
      } catch (error) {
        console.warn('Admin check failed:', error);
        return false;
      }
    },
    enabled: !!user,
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
