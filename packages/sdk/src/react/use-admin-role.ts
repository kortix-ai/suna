import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getAdminRole, type AdminRole } from '../core/rest/projects-client/account-lifecycle';

export const ADMIN_ROLE_QUERY_KEY = 'admin-role';

/**
 * The signed-in user's platform-admin role (`GET /user-roles`).
 *
 * The host passes the user id (its auth provider is not the SDK's business):
 * the id keys the cache and, when absent, disables the query. Short stale
 * window and refetch on mount/focus: a revoked role must stop gating admin
 * hooks within one navigation or tab switch, not after a 5 minute cache.
 */
export function useAdminRole(
  userId: string | null | undefined,
  options?: Partial<UseQueryOptions<AdminRole>>,
) {
  return useQuery<AdminRole>({
    queryKey: [ADMIN_ROLE_QUERY_KEY, userId],
    queryFn: async () => (userId ? getAdminRole() : { isAdmin: false, role: null }),
    enabled: !!userId && options?.enabled !== false,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    ...options,
  });
}
