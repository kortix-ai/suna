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
        console.log('🔍 Checking admin access...');
        
        // First test if the API is even available
        const testResponse = await apiClient.request('/api/enterprise/test');
        console.log('✅ Enterprise API test:', testResponse);
        
        // Then check admin access
        const response = await apiClient.request('/api/enterprise/check-admin');
        console.log('✅ Admin check response:', response);
        
        return response.data?.is_admin || false;
      } catch (error: any) {
        console.warn('❌ Admin check failed:', error);
        console.warn('Error details:', {
          status: error?.status,
          message: error?.message,
          url: error?.response?.url
        });
        return false;
      }
    },
    enabled: !!user,
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
