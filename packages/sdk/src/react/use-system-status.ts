/**
 * Admin system-status hooks. The API removed `/v1/admin/system-status`. These
 * hooks stay exported until the next major and fail with `ENDPOINT_RETIRED`
 * without sending a request.
 */
import { useRetiredMutation, useRetiredQuery } from './retired-endpoint';

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface MaintenanceNotice {
  enabled: boolean;
  start_time?: string | null;
  end_time?: string | null;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface TechnicalIssue {
  enabled: boolean;
  message?: string | null;
  status_url?: string | null;
  affected_services?: string[] | null;
  description?: string | null;
  estimated_resolution?: string | null;
  severity?: 'degraded' | 'outage' | 'maintenance' | null;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface SystemStatus {
  maintenance_notice: MaintenanceNotice;
  technical_issue: TechnicalIssue;
  updated_at?: string | null;
  updated_by?: string | null;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface UpdateMaintenanceRequest {
  enabled: boolean;
  start_time?: string | null;
  end_time?: string | null;
}

/** @deprecated No replacement: the API removed the admin route this type describes. Removed in the next major. */
export interface UpdateTechnicalIssueRequest {
  enabled: boolean;
  message?: string | null;
  status_url?: string | null;
  affected_services?: string[] | null;
  description?: string | null;
  estimated_resolution?: string | null;
  severity?: 'degraded' | 'outage' | 'maintenance' | null;
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export const useSystemStatus = () => useRetiredQuery<SystemStatus>('useSystemStatus', ['admin-system-status']);

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export const useUpdateMaintenanceNotice = () => useRetiredMutation<SystemStatus | undefined, UpdateMaintenanceRequest>('useUpdateMaintenanceNotice');

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export const useUpdateTechnicalIssue = () => useRetiredMutation<SystemStatus | undefined, UpdateTechnicalIssueRequest>('useUpdateTechnicalIssue');

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export const useClearSystemStatus = () => useRetiredMutation<SystemStatus | undefined, void>('useClearSystemStatus');
