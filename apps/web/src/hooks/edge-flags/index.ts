'use client';

import { useQuery } from '@tanstack/react-query';
import type { MaintenanceConfig } from '@/lib/maintenance-store';

async function fetchMaintenanceConfig(): Promise<MaintenanceConfig> {
  try {
    const response = await fetch('/api/maintenance');
    if (!response.ok) {
      console.warn('Failed to fetch maintenance config:', response.status);
      return { level: 'none', title: '', message: '', updatedAt: new Date().toISOString() };
    }
    return await response.json();
  } catch (error) {
    console.warn('Failed to fetch maintenance config:', error);
    return { level: 'none', title: '', message: '', updatedAt: new Date().toISOString() };
  }
}

export const systemStatusKeys = {
  config: ['maintenance-config'] as const,
} as const;

export const useMaintenanceConfig = (options?: { enabled?: boolean }) => {
  return useQuery<MaintenanceConfig>({
    queryKey: systemStatusKeys.config,
    queryFn: fetchMaintenanceConfig,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    retry: 2,
    placeholderData: { level: 'none', title: '', message: '', updatedAt: new Date().toISOString() },
    ...options,
  });
};
