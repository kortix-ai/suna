/**
 * Admin system-status hooks. The API removed `/v1/admin/system-status`. These
 * hooks stay exported until the next major and fail with `ENDPOINT_RETIRED`
 * without sending a request.
 */
import { useRetiredMutation, useRetiredQuery } from './retired-endpoint';

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

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export const useSystemStatus = () => useRetiredQuery<SystemStatus>('useSystemStatus', ['admin-system-status']);

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export const useUpdateMaintenanceNotice = () => useRetiredMutation<SystemStatus | undefined, UpdateMaintenanceRequest>('useUpdateMaintenanceNotice');

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export const useUpdateTechnicalIssue = () => useRetiredMutation<SystemStatus | undefined, UpdateTechnicalIssueRequest>('useUpdateTechnicalIssue');

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export const useClearSystemStatus = () => useRetiredMutation<SystemStatus | undefined, void>('useClearSystemStatus');
