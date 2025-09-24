import { useQuery, UseQueryOptions } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { GetAccountsResponse } from '@usebasejump/shared';

export const useAccounts = (options?: Partial<UseQueryOptions<GetAccountsResponse>> & { enabled?: boolean }) => {
  const supabaseClient = createClient();
  return useQuery<GetAccountsResponse>({
    queryKey: ['accounts'],
    queryFn: async () => {
      const { data, error } = await supabaseClient.rpc('get_accounts');
      if (error) {
        throw new Error(error.message);
      }
      return data;
    },
    enabled: options?.enabled !== false,
    ...options,
  });
};