import { systemStatusKeys } from '@/hooks/edge-flags';
import type { MaintenanceConfig } from '@/lib/maintenance-store';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const useMaintenanceAdmin = () => {
  return useQuery<MaintenanceConfig>({
    queryKey: ['admin-maintenance-config'],
    queryFn: async () => {
      const res = await fetch('/api/maintenance');
      if (!res.ok) throw new Error('Failed to fetch maintenance config');
      return res.json();
    },
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
};

export const useUpdateMaintenanceConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: Partial<MaintenanceConfig>) => {
      const res = await fetch('/api/maintenance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to update (${res.status})`);
      }

      return res.json() as Promise<MaintenanceConfig>;
    },
    onSuccess: (saved) => {
      // Write the saved value straight into the cache. `GET /api/maintenance`
      // is CDN-cached for ~10 s, so a refetch here could paint the previous
      // state over the one the admin just saved.
      queryClient.setQueryData(['admin-maintenance-config'], saved);
      queryClient.setQueryData(systemStatusKeys.config, saved);
      queryClient.invalidateQueries({ queryKey: systemStatusKeys.all });
    },
  });
};
