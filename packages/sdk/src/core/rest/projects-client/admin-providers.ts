import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ── types ──────────────────────────────────────────────────────────────────
export interface AdminProviderDistribution {
  allowed: string[];
  default: string;
  weights: Record<string, number>;
}
export interface AdminProviderSandbox {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  projectId: string;
  provider: string;
  externalId: string | null;
  status: string;
  lastUsedAt: string | null;
}
export interface AdminProviderSandboxesResponse {
  sandboxes: AdminProviderSandbox[];
  byProvider: { provider: string; count: number }[];
}
export interface AdminProviderStat {
  provider: string;
  provisions: number;
  ok: number;
  error: number;
  stopped: number;
  successRate: number | null;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
  phases: { label: string; avgMs: number }[];
}
export interface AdminProviderAnalytics {
  days: number;
  totals: {
    provisions: number;
    ok: number;
    error: number;
    stopped: number;
    migrations: number;
    successRate: number | null;
  };
  providers: AdminProviderStat[];
  latencyByDay: Record<string, unknown>[];
  volumeByDay: Record<string, unknown>[];
  migrations: { flow: string; count: number }[];
  recentErrors: {
    provider: string;
    errorClass: string | null;
    error: string | null;
    createdAt: string;
  }[];
}

export function getAdminProviderDistribution<T = AdminProviderDistribution>(): Promise<T> {
  return backendApi.get<T>('/admin/api/provider-distribution').then((response) => unwrap(response));
}

export function listAdminSandboxes<T = AdminProviderSandboxesResponse>(limit = 300): Promise<T> {
  return backendApi
    .get<T>(`/admin/api/sandboxes?limit=${limit}`)
    .then((response) => unwrap(response));
}

export function setAdminProviderDistribution<T = unknown>(weights: Record<string, number>): Promise<T> {
  return backendApi.put<T>('/admin/api/provider-distribution', weights).then((response) => unwrap(response));
}

export function getAdminProviderAnalytics<T = AdminProviderAnalytics>(days: number): Promise<T> {
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
