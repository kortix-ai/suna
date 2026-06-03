import { useQuery, UseQueryOptions } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';

interface AdminRoleResponse {
  isAdmin: boolean;
  role?: 'admin' | 'super_admin' | null;
}

const ADMIN_ROLE_QUERY_KEY = 'admin-role';

export const useAdminRole = (
  options?: Partial<UseQueryOptions<AdminRoleResponse>>
) => {
  const { user } = useAuth();

  return useQuery<AdminRoleResponse>({
    queryKey: [ADMIN_ROLE_QUERY_KEY, user?.id],
    queryFn: async () => {
      if (!user) {
        return { isAdmin: false, role: null };
      }

      const response = await backendApi.get<AdminRoleResponse>('/user-roles', {
        showErrors: false,
      });

      if (response.error) {
        // Silently handle errors (e.g. 404 when backend doesn't have this endpoint)
        return { isAdmin: false, role: null };
      }

      return response.data || { isAdmin: false, role: null };
    },
    enabled: !!user && (options?.enabled !== false),
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    ...options,
  });
};
