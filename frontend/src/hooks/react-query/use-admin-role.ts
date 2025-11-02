import { useQuery, UseQueryOptions } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/AuthProvider';

interface AdminRoleResponse {
  isAdmin: boolean;
  role?: 'admin' | 'super_admin' | null;
}

export const useAdminRole = (
  options?: Partial<UseQueryOptions<AdminRoleResponse>>
) => {
  const { user } = useAuth();
  const supabaseClient = createClient();

  return useQuery<AdminRoleResponse>({
    queryKey: ['admin-role', user?.id],
    queryFn: async () => {
      if (!user) {
        return { isAdmin: false, role: null };
      }

      const { data: roleData, error } = await supabaseClient
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .in('role', ['admin', 'super_admin'])
        .maybeSingle();

      if (error) {
        console.error('Error fetching admin role:', error);
        return { isAdmin: false, role: null };
      }

      return {
        isAdmin: !!roleData,
        role: roleData?.role as 'admin' | 'super_admin' | null,
      };
    },
    enabled: !!user && (options?.enabled !== false),
    staleTime: 5 * 60 * 1000,
    ...options,
  });
};
