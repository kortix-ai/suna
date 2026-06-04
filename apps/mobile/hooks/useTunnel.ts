/**
 * React Query hooks for Tunnel management.
 * Mirrors the frontend's tunnel API against the backend /tunnel endpoints.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_URL, getAuthToken } from '@/api/config';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TunnelConnection {
  tunnelId: string;
  accountId: string;
  sandboxId: string | null;
  name: string;
  status: 'online' | 'offline' | 'connecting';
  capabilities: string[];
  machineInfo: Record<string, unknown>;
  lastHeartbeatAt: string | null;
  isLive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TunnelConnectionCreateResponse extends TunnelConnection {
  /** One-time setup token — only returned on creation, never retrievable again. */
  setupToken: string;
}

export interface TunnelPermission {
  permissionId: string;
  tunnelId: string;
  accountId: string;
  capability: string;
  scope: Record<string, unknown>;
  status: 'active' | 'revoked' | 'expired';
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TunnelPermissionRequest {
  requestId: string;
  tunnelId: string;
  accountId: string;
  capability: string;
  requestedScope: Record<string, unknown>;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  updatedAt: string;
}

export interface TunnelAuditLog {
  logId: string;
  tunnelId: string;
  accountId: string;
  capability: string;
  operation: string;
  requestSummary: Record<string, unknown>;
  success: boolean;
  durationMs: number | null;
  bytesTransferred: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AuditLogPage {
  data: TunnelAuditLog[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ─── Scope registry ─────────────────────────────────────────────────────────

export interface ScopeInfo {
  key: string;
  capability: string;
  label: string;
  description: string;
  category: string;
}

export const SCOPE_REGISTRY: ScopeInfo[] = [
  { key: 'files:read',  capability: 'filesystem', label: 'Read files',       description: 'Read local files and directories',   category: 'Filesystem' },
  { key: 'files:write', capability: 'filesystem', label: 'Write files',      description: 'Create and modify local files',      category: 'Filesystem' },
  { key: 'files:delete',capability: 'filesystem', label: 'Delete files',     description: 'Delete local files and directories', category: 'Filesystem' },
  { key: 'shell:exec',  capability: 'shell',      label: 'Execute commands', description: 'Run shell commands in terminal',     category: 'Shell' },
];

// ─── API Helpers ────────────────────────────────────────────────────────────

async function authFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string>),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error || body?.message || body?.detail || `Request failed (${res.status})`);
  }
  return body;
}

// ─── API Functions ──────────────────────────────────────────────────────────
// Note: Tunnel backend returns data directly (no { success, data } envelope)

async function listConnections(): Promise<TunnelConnection[]> {
  return authFetch<TunnelConnection[]>('/tunnel/connections');
}

async function getConnection(tunnelId: string): Promise<TunnelConnection> {
  return authFetch<TunnelConnection>(`/tunnel/connections/${tunnelId}`);
}

async function createConnection(data: { name: string; sandboxId?: string; capabilities?: string[] }): Promise<TunnelConnectionCreateResponse> {
  return authFetch<TunnelConnectionCreateResponse>(
    '/tunnel/connections',
    { method: 'POST', body: JSON.stringify(data) },
  );
}

async function updateConnection(tunnelId: string, data: { name?: string; capabilities?: string[] }): Promise<TunnelConnection> {
  return authFetch<TunnelConnection>(
    `/tunnel/connections/${tunnelId}`,
    { method: 'PATCH', body: JSON.stringify(data) },
  );
}

async function deleteConnection(tunnelId: string): Promise<void> {
  await authFetch(`/tunnel/connections/${tunnelId}`, { method: 'DELETE' });
}

async function listPermissions(tunnelId: string): Promise<TunnelPermission[]> {
  return authFetch<TunnelPermission[]>(`/tunnel/permissions/${tunnelId}`);
}

async function grantPermission(tunnelId: string, data: { capability: string; scope?: Record<string, unknown>; expiresAt?: string }): Promise<TunnelPermission> {
  return authFetch<TunnelPermission>(
    `/tunnel/permissions/${tunnelId}`,
    { method: 'POST', body: JSON.stringify(data) },
  );
}

async function revokePermission(tunnelId: string, permissionId: string): Promise<void> {
  await authFetch(`/tunnel/permissions/${tunnelId}/${permissionId}`, { method: 'DELETE' });
}

async function fetchAuditLogs(tunnelId: string, page: number, limit: number): Promise<AuditLogPage> {
  return authFetch<AuditLogPage>(
    `/tunnel/audit/${tunnelId}?page=${page}&limit=${limit}`,
  );
}

// ─── Query Keys ─────────────────────────────────────────────────────────────

export const tunnelKeys = {
  all: ['tunnel'] as const,
  connections: () => [...tunnelKeys.all, 'connections'] as const,
  connection: (id: string) => [...tunnelKeys.all, 'connection', id] as const,
  permissions: (tunnelId: string) => [...tunnelKeys.all, 'permissions', tunnelId] as const,
  auditLogs: (tunnelId: string, page: number) => [...tunnelKeys.all, 'audit', tunnelId, page] as const,
};

// ─── Connection Hooks ───────────────────────────────────────────────────────

export function useTunnelConnections() {
  return useQuery({
    queryKey: tunnelKeys.connections(),
    queryFn: listConnections,
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
}

export function useTunnelConnection(tunnelId: string) {
  return useQuery({
    queryKey: tunnelKeys.connection(tunnelId),
    queryFn: () => getConnection(tunnelId),
    enabled: !!tunnelId,
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
}

export function useCreateTunnelConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createConnection,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tunnelKeys.connections() });
    },
  });
}

export function useUpdateTunnelConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tunnelId, ...data }: { tunnelId: string; name?: string; capabilities?: string[] }) =>
      updateConnection(tunnelId, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: tunnelKeys.connections() });
      qc.invalidateQueries({ queryKey: tunnelKeys.connection(vars.tunnelId) });
    },
  });
}

export function useDeleteTunnelConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tunnelKeys.connections() });
    },
  });
}

// ─── Permission Hooks ───────────────────────────────────────────────────────

export function useTunnelPermissions(tunnelId: string) {
  return useQuery({
    queryKey: tunnelKeys.permissions(tunnelId),
    queryFn: () => listPermissions(tunnelId),
    enabled: !!tunnelId,
    staleTime: 10_000,
  });
}

export function useGrantTunnelPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tunnelId, ...data }: { tunnelId: string; capability: string; scope?: Record<string, unknown>; expiresAt?: string }) =>
      grantPermission(tunnelId, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: tunnelKeys.permissions(vars.tunnelId) });
    },
  });
}

export function useRevokeTunnelPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tunnelId, permissionId }: { tunnelId: string; permissionId: string }) =>
      revokePermission(tunnelId, permissionId),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: tunnelKeys.permissions(vars.tunnelId) });
    },
  });
}

// ─── Audit Log Hooks ────────────────────────────────────────────────────────

export function useTunnelAuditLogs(tunnelId: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: tunnelKeys.auditLogs(tunnelId, page),
    queryFn: () => fetchAuditLogs(tunnelId, page, limit),
    enabled: !!tunnelId,
    staleTime: 15_000,
  });
}

// ─── Utilities ──────────────────────────────────────────────────────────────

export function formatTunnelDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatRelativeTime(dateString: string): string {
  const diff = Date.now() - new Date(dateString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
