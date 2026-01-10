import { useQuery } from '@tanstack/react-query';
import { API_URL } from '@/api/config';

export interface MaintenanceNotice {
  enabled: boolean;
  startTime?: string;
  endTime?: string;
}

export interface TechnicalIssue {
  enabled: boolean;
  message?: string;
  statusUrl?: string;
  affectedServices?: string[];
  description?: string;
  estimatedResolution?: string;
  severity?: 'degraded' | 'outage' | 'maintenance';
}

export interface SystemStatus {
  maintenanceNotice: MaintenanceNotice;
  technicalIssue: TechnicalIssue;
}

async function fetchSystemStatus(): Promise<SystemStatus> {
  try {
    const response = await fetch(`${API_URL}/system/status`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch system status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.warn('Failed to fetch system status:', error);
    return {
      maintenanceNotice: { enabled: false },
      technicalIssue: { enabled: false },
    };
  }
}

export function useSystemStatus() {
  return useQuery<SystemStatus>({
    queryKey: ['system-status'],
    queryFn: fetchSystemStatus,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 3,
    placeholderData: {
      maintenanceNotice: { enabled: false },
      technicalIssue: { enabled: false },
    },
  });
}

export function useMaintenanceNotice() {
  const { data, ...rest } = useSystemStatus();
  return {
    ...rest,
    data: data?.maintenanceNotice || { enabled: false },
  };
}

export function useTechnicalIssue() {
  const { data, ...rest } = useSystemStatus();
  return {
    ...rest,
    data: data?.technicalIssue || { enabled: false },
  };
}
