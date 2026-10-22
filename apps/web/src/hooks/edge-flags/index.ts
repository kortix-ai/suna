'use client';

import { unknownMaintenanceConfig } from '@/lib/maintenance-client';
import type { MaintenanceConfig } from '@/lib/maintenance-store';
import { useQuery } from '@tanstack/react-query';

async function fetchMaintenanceConfig(): Promise<MaintenanceConfig> {
  try {
    const response = await fetch('/api/maintenance');
    if (!response.ok) {
      console.warn('Failed to fetch maintenance config:', response.status);
      return unknownMaintenanceConfig();
    }
    return await response.json();
  } catch (error) {
    console.warn('Failed to fetch maintenance config:', error);
    return unknownMaintenanceConfig();
  }
}

export const systemStatusKeys = {
  all: ['system-status'] as const,
  config: ['maintenance-config'] as const,
} as const;

// ---------------------------------------------------------------------------
// Primary hook — returns the raw MaintenanceConfig
// ---------------------------------------------------------------------------

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
