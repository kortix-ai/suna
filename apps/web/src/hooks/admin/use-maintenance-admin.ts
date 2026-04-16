import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { systemStatusKeys } from '@/hooks/edge-flags';
import type { MaintenanceConfig } from '@/lib/maintenance-store';

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-maintenance-config'] });
      queryClient.invalidateQueries({ queryKey: systemStatusKeys.all });
      queryClient.invalidateQueries({ queryKey: systemStatusKeys.config });
    },
  });
};
