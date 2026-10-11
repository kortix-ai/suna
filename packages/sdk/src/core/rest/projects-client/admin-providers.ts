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

// ── Volumes (the master switch) and session boot modes ───────────────────────
export type AdminBootMode = 'standard' | 'artifacts' | 'volume';
export interface AdminBootModeRule {
  mode: AdminBootMode;
  standardFallback: boolean;
}
export interface AdminVolumesPolicy {
  enabled: boolean;
  percent: number;
  orgs: Record<string, boolean>;
}
export interface AdminBootModePolicy {
  volumes: AdminVolumesPolicy;
  killSwitch: boolean;
  default: AdminBootModeRule;
  orgs: Record<string, AdminBootModeRule>;
  fallback: { volumeAttempts: number; artifactsAttempts: number };
  artifacts: string | null;
}
export interface AdminBootModes {
  stored: boolean;
  policy: AdminBootModePolicy;
  orgs: Array<{ accountId: string; name: string | null; volumes: boolean | null; rule: AdminBootModeRule | null }>;
  env: { bootArtifacts: string | null; volumeOff: boolean; driveSync: boolean };
  providers: { allowed: string[]; default: string; volumeProvider: string; volumeProviderConfigured: boolean };
  stats:
    | {
        since: string;
        modes: { mode: AdminBootMode; requested: number; booted: number }[];
        fallbacks: { from: AdminBootMode; to: AdminBootMode; reason: string; count: number; sample: string | null }[];
      }
    | { error: string };
}

export function getAdminBootModes(): Promise<AdminBootModes> {
  return backendApi.get<AdminBootModes>('/admin/api/boot-modes').then((response) => unwrap(response));
}

export function setAdminBootModes(policy: AdminBootModePolicy): Promise<AdminBootModes> {
  return backendApi.put<AdminBootModes>('/admin/api/boot-modes', policy).then((response) => unwrap(response));
}
