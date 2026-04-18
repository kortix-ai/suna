'use client';

/**
 * Tunnel hooks — TanStack React Query hooks for the tunnel API.
 *
 * Provides:
 *   - useTunnelConnections()          — list tunnel connections
 *   - useTunnelConnection(tunnelId)   — single connection detail
 *   - useCreateTunnelConnection()     — create a new connection
 *   - useUpdateTunnelConnection()     — update connection
 *   - useDeleteTunnelConnection()     — delete connection
 *   - useTunnelPermissions(tunnelId)  — list permissions
 *   - useGrantTunnelPermission()      — grant permission
 *   - useRevokeTunnelPermission()     — revoke permission
 *   - useTunnelPermissionRequests()   — list pending requests
 *   - useApprovePermissionRequest()   — approve request
 *   - useDenyPermissionRequest()      — deny request
 *   - useTunnelAuditLogs(tunnelId)    — paginated audit logs
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const tunnelKeys = {
  all: ['tunnel'] as const,
  connections: () => [...tunnelKeys.all, 'connections'] as const,
  connection: (id: string) => [...tunnelKeys.all, 'connection', id] as const,
  permissions: (tunnelId: string) => [...tunnelKeys.all, 'permissions', tunnelId] as const,
  permissionRequests: () => [...tunnelKeys.all, 'permission-requests'] as const,
  auditLogs: (tunnelId: string, page: number) => [...tunnelKeys.all, 'audit', tunnelId, page] as const,
  deviceAuth: (code: string) => [...tunnelKeys.all, 'device-auth', code] as const,
};

// ─── Connection Hooks ────────────────────────────────────────────────────────

export function useTunnelConnections() {
  return useQuery({
    queryKey: tunnelKeys.connections(),
    queryFn: async () => {
      const res = await backendApi.get<TunnelConnection[]>('/tunnel/connections', {
        showErrors: false,
        timeout: 10_000,
      });
      if (!res.success) throw new Error(res.error?.message || 'Failed to fetch connections');
      return res.data!;
    },
    staleTime: 2_000,
    refetchInterval: 5_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}

export function useTunnelConnection(tunnelId: string) {
  return useQuery({
    queryKey: tunnelKeys.connection(tunnelId),
    queryFn: async () => {
      const res = await backendApi.get<TunnelConnection>(`/tunnel/connections/${tunnelId}`, {
        showErrors: false,
        timeout: 10_000,
      });
      if (!res.success) throw new Error(res.error?.message || 'Failed to fetch connection');
      return res.data!;
    },
    enabled: !!tunnelId,
    staleTime: 2_000,
    refetchInterval: 5_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}

export interface TunnelConnectionCreateResponse extends TunnelConnection {
  /** One-time setup token — only returned on creation, never retrievable again. */
  setupToken: string;
}

export function useCreateTunnelConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; sandboxId?: string; capabilities?: string[] }) => {
      const res = await backendApi.post<TunnelConnectionCreateResponse>('/tunnel/connections', data);
      if (!res.success) throw new Error(res.error?.message || 'Failed to create connection');
      return res.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
    },
  });
}

export function useUpdateTunnelConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ tunnelId, ...data }: { tunnelId: string; name?: string; capabilities?: string[] }) => {
      const res = await backendApi.patch<TunnelConnection>(`/tunnel/connections/${tunnelId}`, data);
      if (!res.success) throw new Error(res.error?.message || 'Failed to update connection');
      return res.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
      queryClient.invalidateQueries({ queryKey: tunnelKeys.connection(vars.tunnelId) });
    },
  });
}

export function useDeleteTunnelConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tunnelId: string) => {
      const res = await backendApi.delete(`/tunnel/connections/${tunnelId}`);
      if (!res.success) throw new Error(res.error?.message || 'Failed to delete connection');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
    },
  });
}

// ─── Permission Hooks ────────────────────────────────────────────────────────

export function useTunnelPermissions(tunnelId: string) {
  return useQuery({
    queryKey: tunnelKeys.permissions(tunnelId),
    queryFn: async () => {
      const res = await backendApi.get<TunnelPermission[]>(`/tunnel/permissions/${tunnelId}`, {
        showErrors: false,
        timeout: 10_000,
      });
      if (!res.success) throw new Error(res.error?.message || 'Failed to fetch permissions');
      return res.data!;
    },
    enabled: !!tunnelId,
    staleTime: 10_000,
  });
}

export function useGrantTunnelPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ tunnelId, ...data }: {
      tunnelId: string;
      capability: string;
      scope?: Record<string, unknown>;
      expiresAt?: string;
    }) => {
      const res = await backendApi.post<TunnelPermission>(`/tunnel/permissions/${tunnelId}`, data);
      if (!res.success) throw new Error(res.error?.message || 'Failed to grant permission');
      return res.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.permissions(vars.tunnelId) });
    },
  });
}

export function useRevokeTunnelPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ tunnelId, permissionId }: { tunnelId: string; permissionId: string }) => {
      const res = await backendApi.delete(`/tunnel/permissions/${tunnelId}/${permissionId}`);
      if (!res.success) throw new Error(res.error?.message || 'Failed to revoke permission');
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.permissions(vars.tunnelId) });
    },
  });
}

// ─── Permission Request Hooks ────────────────────────────────────────────────

export function useTunnelPermissionRequests() {
  return useQuery({
    queryKey: tunnelKeys.permissionRequests(),
    queryFn: async () => {
      const res = await backendApi.get<TunnelPermissionRequest[]>('/tunnel/permission-requests', {
        showErrors: false,
        timeout: 10_000,
      });
      if (!res.success) throw new Error(res.error?.message || 'Failed to fetch requests');
      return res.data!;
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}

export function useApprovePermissionRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ requestId, scope, expiresAt }: {
      requestId: string;
      scope?: Record<string, unknown>;
      expiresAt?: string;
    }) => {
      const res = await backendApi.post(`/tunnel/permission-requests/${requestId}/approve`, {
        scope,
        expiresAt,
      });
      if (!res.success) throw new Error(res.error?.message || 'Failed to approve request');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.permissionRequests() });
      queryClient.invalidateQueries({ queryKey: tunnelKeys.all });
    },
  });
}

export function useDenyPermissionRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string) => {
      const res = await backendApi.post(`/tunnel/permission-requests/${requestId}/deny`);
      if (!res.success) throw new Error(res.error?.message || 'Failed to deny request');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.permissionRequests() });
    },
  });
}

// ─── Device Auth Hooks ──────────────────────────────────────────────────────

export interface DeviceAuthInfo {
  deviceCode: string;
  machineHostname: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: string;
  createdAt: string;
}

export function useDeviceAuthInfo(code: string) {
  return useQuery({
    queryKey: tunnelKeys.deviceAuth(code),
    queryFn: async () => {
      const res = await backendApi.get<DeviceAuthInfo>(`/tunnel/device-auth/${code}/info`, {
        showErrors: false,
        timeout: 10_000,
      });
      if (!res.success) throw new Error(res.error?.message || 'Failed to fetch device auth info');
      return res.data!;
    },
    enabled: !!code,
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
}

export function useApproveDeviceAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, ...data }: {
      code: string;
      name?: string;
      capabilities?: string[];
    }) => {
      const res = await backendApi.post<{ success: boolean; tunnelId: string }>(
        `/tunnel/device-auth/${code}/approve`,
        data,
      );
      if (!res.success) throw new Error(res.error?.message || 'Failed to approve device');
      return res.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.deviceAuth(vars.code) });
      queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
    },
  });
}

export function useDenyDeviceAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const res = await backendApi.post(`/tunnel/device-auth/${code}/deny`);
      if (!res.success) throw new Error(res.error?.message || 'Failed to deny device');
    },
    onSuccess: (_, code) => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.deviceAuth(code) });
    },
  });
}

// ─── Audit Log Hooks ─────────────────────────────────────────────────────────

export function useTunnelAuditLogs(tunnelId: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: tunnelKeys.auditLogs(tunnelId, page),
    queryFn: async () => {
      const res = await backendApi.get<AuditLogPage>(`/tunnel/audit/${tunnelId}?page=${page}&limit=${limit}`, {
        showErrors: false,
        timeout: 10_000,
      });
      if (!res.success) throw new Error(res.error?.message || 'Failed to fetch audit logs');
      return res.data!;
    },
    enabled: !!tunnelId,
    staleTime: 15_000,
  });
}
