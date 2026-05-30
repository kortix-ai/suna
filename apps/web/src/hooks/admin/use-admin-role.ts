import { useQuery, UseQueryOptions, type QueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';

interface AdminRoleResponse {
  isAdmin: boolean;
  role?: 'admin' | 'super_admin' | null;
}

export const ADMIN_ROLE_QUERY_KEY = 'admin-role';

const ADMIN_REVOKED_RE = /admin access required|forbidden|403/i;

/**
 * Shared guard for admin polling queries. If a query errors with a
 * 403/forbidden, the caller's admin role has been revoked (or the
 * `useAdminRole` cache is stale): invalidate that cache so the next render
 * drops `isAdmin` to false and stops firing admin calls, then return `false`
 * to halt the refetch interval. Otherwise keep polling at `intervalMs`.
 *
 * Use as `refetchInterval: (q) => stopOnAdminRevoked(qc, q.state.error, ms)`.
 */
export function stopOnAdminRevoked(
  qc: QueryClient,
  err: unknown,
  intervalMs: number,
): false | number {
  const msg = err instanceof Error ? err.message : '';
  if (ADMIN_REVOKED_RE.test(msg)) {
    qc.invalidateQueries({ queryKey: [ADMIN_ROLE_QUERY_KEY] });
    return false;
  }
  return intervalMs;
}

/** Don't retry an admin query that failed because the role was revoked. */
export function isAdminRevokedError(err: unknown): boolean {
  return ADMIN_REVOKED_RE.test(err instanceof Error ? err.message : '');
}

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
