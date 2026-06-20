import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface MaintenanceNotice {
  enabled: boolean;
  start_time?: string | null;
  end_time?: string | null;
}

export interface TechnicalIssue {
  enabled: boolean;
  message?: string | null;
  status_url?: string | null;
  affected_services?: string[] | null;
  description?: string | null;
  estimated_resolution?: string | null;
  severity?: 'degraded' | 'outage' | 'maintenance' | null;
}

export interface SystemStatus {
  maintenance_notice: MaintenanceNotice;
  technical_issue: TechnicalIssue;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface UpdateMaintenanceRequest {
  enabled: boolean;
  start_time?: string | null;
  end_time?: string | null;
}

export interface UpdateTechnicalIssueRequest {
  enabled: boolean;
  message?: string | null;
  status_url?: string | null;
  affected_services?: string[] | null;
  description?: string | null;
  estimated_resolution?: string | null;
  severity?: 'degraded' | 'outage' | 'maintenance' | null;
}

export const useSystemStatus = () => {
  return useQuery<SystemStatus>({
    queryKey: ['admin-system-status'],
    queryFn: async () => {
      const response = await backendApi.get<SystemStatus>('/admin/system-status');
      if (response.error) {
        throw response.error;
      }
      return response.data || {
        maintenance_notice: { enabled: false },
        technical_issue: { enabled: false },
      };
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
};

export const useUpdateMaintenanceNotice = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateMaintenanceRequest) => {
      const response = await backendApi.put<SystemStatus>('/admin/system-status/maintenance', data);
      if (response.error) {
        throw response.error;
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-system-status'] });
      queryClient.invalidateQueries({ queryKey: ['system-status'] });
    },
  });
};

export const useUpdateTechnicalIssue = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateTechnicalIssueRequest) => {
      const response = await backendApi.put<SystemStatus>('/admin/system-status/technical-issue', data);
      if (response.error) {
        throw response.error;
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-system-status'] });
      queryClient.invalidateQueries({ queryKey: ['system-status'] });
    },
  });
};

export const useClearSystemStatus = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await backendApi.delete<SystemStatus>('/admin/system-status');
      if (response.error) {
        throw response.error;
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-system-status'] });
      queryClient.invalidateQueries({ queryKey: ['system-status'] });
    },
  });
};
