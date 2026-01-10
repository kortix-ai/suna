import { useQuery } from '@tanstack/react-query';
import { API_URL, getAuthHeaders } from '@/api/config';
import { log } from '@/lib/logger';

interface AdminRoleResponse {
  isAdmin: boolean;
  role?: 'admin' | 'super_admin' | null;
}

export function useAdminRole() {
  return useQuery<AdminRoleResponse>({
    queryKey: ['admin-role'],
    queryFn: async () => {
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(`${API_URL}/user-roles`, {
          headers,
        });

        if (!response.ok) {
          return { isAdmin: false, role: null };
        }

        return await response.json();
      } catch (error) {
        log.warn('Failed to check admin role:', error);
        return { isAdmin: false, role: null };
      }
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
