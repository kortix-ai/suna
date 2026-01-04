import { useQuery, UseQueryOptions } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { GetAccountsResponse } from '@usebasejump/shared';

export const useAccounts = (options?: Partial<UseQueryOptions<GetAccountsResponse>> & { enabled?: boolean }) => {
  return useQuery<GetAccountsResponse>({
    queryKey: ['accounts'],
    queryFn: async () => {
      const response = await backendApi.get<GetAccountsResponse>('/accounts', {
        showErrors: false,
      });
      
      if (response.error) {
        throw new Error(response.error.message || 'Failed to fetch accounts');
      }
      
      return response.data || [];
    },
    enabled: options?.enabled !== false,
    ...options,
  });
};