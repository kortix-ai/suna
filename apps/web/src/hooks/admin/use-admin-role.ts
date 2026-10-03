import { useAuth } from '@/features/providers/auth-provider';
import { getAdminRole } from '@kortix/sdk';
import { useQuery, UseQueryOptions } from '@tanstack/react-query';

interface AdminRoleResponse {
  isAdmin: boolean;
  role?: 'admin' | 'super_admin' | null;
}

export const ADMIN_ROLE_QUERY_KEY = 'admin-role';

export const useAdminRole = (options?: Partial<UseQueryOptions<AdminRoleResponse>>) => {
  const { user } = useAuth();

  return useQuery<AdminRoleResponse>({
    queryKey: [ADMIN_ROLE_QUERY_KEY, user?.id],
    queryFn: async () => {
      if (!user) {
        return { isAdmin: false, role: null };
      }

      return getAdminRole();
    },
    enabled: !!user && options?.enabled !== false,
    // Previously: staleTime 5min + refetchOnMount:false + refetchOnFocus:false
    // meant a `{isAdmin:true}` value cached once was served for 5 minutes
    // regardless of route changes, which caused every admin-gated hook to
    // keep firing /admin/api/* calls long after the role had been revoked
    // (or after a DB reset in dev) — and the server correctly returned 403.
    // Drop the stale window to 30s and let it refetch on mount / focus so
    // role flips propagate within one navigation or tab-switch.
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    ...options,
  });
};
