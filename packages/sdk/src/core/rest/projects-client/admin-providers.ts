import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export function getAdminProviderDistribution<T = unknown>(): Promise<T> {
  return backendApi.get<T>('/admin/api/provider-distribution').then((response) => unwrap(response));
}

export function listAdminSandboxes<T = unknown>(limit = 300): Promise<T> {
  return backendApi
    .get<T>(`/admin/api/sandboxes?limit=${limit}`)
    .then((response) => unwrap(response));
}

export function setAdminProviderDistribution<T = unknown>(weights: Record<string, number>): Promise<T> {
  return backendApi.put<T>('/admin/api/provider-distribution', weights).then((response) => unwrap(response));
}

export function getAdminProviderAnalytics<T = unknown>(days: number): Promise<T> {
  return backendApi
    .get<T>(`/admin/api/provider-analytics?days=${days}`)
    .then((response) => unwrap(response));
}

export function migrateAdminSandboxProvider<T = unknown>(
  sessionId: string,
  targetProvider: string,
): Promise<T> {
  return backendApi
    .post<T>(`/admin/api/sandboxes/${encodeURIComponent(sessionId)}/migrate`, { targetProvider })
    .then((response) => unwrap(response));
}

export function getAdminProviderFallback(): Promise<{ enabled: boolean }> {
  return backendApi
    .get<{ enabled: boolean }>('/admin/api/provider-fallback')
    .then((response) => unwrap(response));
}

export function setAdminProviderFallback<T = unknown>(enabled: boolean): Promise<T> {
  return backendApi
    .put<T>('/admin/api/provider-fallback', { enabled })
    .then((response) => unwrap(response));
}
