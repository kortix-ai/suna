'use client';

import { useQuery } from '@tanstack/react-query';
import type { MaintenanceConfig, MaintenanceLevel } from '@/lib/maintenance-store';

// Re-export types for consumers
export type { MaintenanceConfig, MaintenanceLevel } from '@/lib/maintenance-store';

// Legacy-compatible interfaces (consumed by layout-content.tsx and other components)
export interface IMaintenanceNotice {
  enabled: boolean;
  startTime?: string;
  endTime?: string;
}

export interface ITechnicalIssue {
  enabled: boolean;
  message?: string;
  statusUrl?: string;
  affectedServices?: string[];
  description?: string;
  estimatedResolution?: string;
  severity?: 'degraded' | 'outage' | 'maintenance';
}

export interface SystemStatusResponse {
  maintenanceNotice: IMaintenanceNotice;
  technicalIssue: ITechnicalIssue;
  updatedAt?: string;
  // New unified config
  maintenanceConfig: MaintenanceConfig;
}

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

/**
 * Map the new MaintenanceConfig to the legacy SystemStatusResponse shape
 * so existing consumers (layout-content.tsx) continue to work during migration.
 */
function toLegacyFormat(config: MaintenanceConfig): SystemStatusResponse {
  const isWarningOrAbove = config.level === 'warning' || config.level === 'critical' || config.level === 'blocking';
  const isActive = config.level !== 'none';

  return {
    maintenanceNotice: {
      enabled: isWarningOrAbove && !!config.startTime && !!config.endTime,
      startTime: config.startTime ?? undefined,
      endTime: config.endTime ?? undefined,
    },
    technicalIssue: {
      enabled: isActive && config.level !== 'blocking',
      message: config.message || undefined,
      statusUrl: config.statusUrl ?? undefined,
      affectedServices: config.affectedServices,
      severity: config.level === 'critical' ? 'outage' : config.level === 'warning' ? 'degraded' : undefined,
    },
    updatedAt: config.updatedAt,
    maintenanceConfig: config,
  };
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

// ---------------------------------------------------------------------------
// Legacy-compatible hook — returns SystemStatusResponse shape
// ---------------------------------------------------------------------------

export const useSystemStatusQuery = (options?: { enabled?: boolean }) => {
  return useQuery<SystemStatusResponse>({
    queryKey: systemStatusKeys.all,
    queryFn: async () => {
      const config = await fetchMaintenanceConfig();
      return toLegacyFormat(config);
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    retry: 2,
    placeholderData: {
      maintenanceNotice: { enabled: false },
      technicalIssue: { enabled: false },
      maintenanceConfig: { level: 'none', title: '', message: '', updatedAt: new Date().toISOString() },
    },
    ...options,
  });
};

export const useMaintenanceNoticeQuery = (options?: { enabled?: boolean }) => {
  const { data, ...rest } = useSystemStatusQuery(options);
  return {
    ...rest,
    data: data?.maintenanceNotice || ({ enabled: false } as IMaintenanceNotice),
  };
};

export const useTechnicalIssueQuery = (options?: { enabled?: boolean }) => {
  const { data, ...rest } = useSystemStatusQuery(options);
  return {
    ...rest,
    data: data?.technicalIssue || ({ enabled: false } as ITechnicalIssue),
  };
};
