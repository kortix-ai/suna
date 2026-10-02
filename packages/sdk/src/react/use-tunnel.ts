'use client';

/**
 * Computer (tunnel) hooks — TanStack React Query hooks for paired machines.
 *
 * A paired computer is an ACCOUNT of the project's `computer` connector: list
 * and select it with the generic connection APIs (`listConnections`,
 * `--account`). These hooks cover the machine itself:
 *   - useTunnelConnections()          — the machines the caller paired
 *   - useTunnelConnection(tunnelId)   — one machine
 *   - useUpdateTunnelConnection()     — rename a machine
 *   - useDeleteTunnelConnection()     — unpair a machine
 *   - useAddComputerToProject()       — add a paired machine to a project
 *   - useDeviceAuthInfo / useApproveDeviceAuth / useDenyDeviceAuth — pairing
 *
 * Retired (the API deleted the routes; the hooks fail with ENDPOINT_RETIRED
 * and send no request): useCreateTunnelConnection, useTunnelPermissions,
 * useGrantTunnelPermission, useRevokeTunnelPermission,
 * useTunnelPermissionRequests, useApprovePermissionRequest,
 * useDenyPermissionRequest, useTunnelAuditLogs.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '../core/http/api-client';
import { addComputerToProject, type ConnectorConnectOwner } from '../core/rest/projects-client';
import { useRetiredMutation, useRetiredQuery } from './retired-endpoint';

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
  /** The human who paired the machine. `null` for a machine paired before
   *  computers became per-member accounts; absent on older servers. */
  ownerUserId?: string | null;
}

/** @deprecated Per-machine permissions are no longer a product surface. Removed in the next major. */
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

/** @deprecated Permission requests were removed; approvals use connector policies. Removed in the next major. */
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

/** @deprecated The tunnel audit log route was removed. Removed in the next major. */
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

/** @deprecated The tunnel audit log route was removed. Removed in the next major. */
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

/** Machines the caller paired. Polls every 5 s; pass a slower `refetchInterval`
 *  (or `false`) when only "has a machine?" matters. */
export function useTunnelConnections(options: { refetchInterval?: number | false } = {}) {
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
    refetchInterval: options.refetchInterval ?? 5_000,
    refetchIntervalInBackground: false,
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
    refetchIntervalInBackground: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}

/** @deprecated Pairing is device-auth only. Removed in the next major. */
export interface TunnelConnectionCreateResponse extends TunnelConnection {
  /** One-time setup token — only returned on creation, never retrievable again. */
  setupToken: string;
}

/**
 * @deprecated The API removed `POST /tunnel/connections`: a machine pairs
 * through device auth (`npx @kortix/agent-tunnel connect`). Fails with
 * `ENDPOINT_RETIRED`. Removed in the next major.
 */
export function useCreateTunnelConnection() {
  return useRetiredMutation<
    TunnelConnectionCreateResponse,
    { name: string; sandboxId?: string; capabilities?: string[] }
  >('useCreateTunnelConnection');
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
      // Unpairing revokes the machine's `computer` accounts in every project.
      queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });
}

// ─── Retired permission hooks ───────────────────────────────────────────────
// Per-machine permission editing and permission requests are no longer a
// product surface. The local agent's config is the ceiling; human approval of
// risky calls is a connector policy (`require_approval`).

/** @deprecated The API removed this route. Fails with `ENDPOINT_RETIRED`. Removed in the next major. */
export function useTunnelPermissions(tunnelId: string) {
  return useRetiredQuery<TunnelPermission[]>('useTunnelPermissions', tunnelKeys.permissions(tunnelId), !!tunnelId);
}

/** @deprecated The API removed this route. Fails with `ENDPOINT_RETIRED`. Removed in the next major. */
export function useGrantTunnelPermission() {
  return useRetiredMutation<
    TunnelPermission,
    { tunnelId: string; capability: string; scope?: Record<string, unknown>; expiresAt?: string }
  >('useGrantTunnelPermission');
}

/** @deprecated The API removed this route. Fails with `ENDPOINT_RETIRED`. Removed in the next major. */
export function useRevokeTunnelPermission() {
  return useRetiredMutation<void, { tunnelId: string; permissionId: string }>('useRevokeTunnelPermission');
}

/** @deprecated The API removed this route. Fails with `ENDPOINT_RETIRED`. Removed in the next major. */
export function useTunnelPermissionRequests() {
  return useRetiredQuery<TunnelPermissionRequest[]>('useTunnelPermissionRequests', tunnelKeys.permissionRequests());
}

/** @deprecated The API removed this route. Fails with `ENDPOINT_RETIRED`. Removed in the next major. */
export function useApprovePermissionRequest() {
  return useRetiredMutation<
    unknown,
    { requestId: string; scope?: Record<string, unknown>; expiresAt?: string }
  >('useApprovePermissionRequest');
}

/** @deprecated The API removed this route. Fails with `ENDPOINT_RETIRED`. Removed in the next major. */
export function useDenyPermissionRequest() {
  return useRetiredMutation<void, string>('useDenyPermissionRequest');
}

// ─── Project Hooks ───────────────────────────────────────────────────────────

/**
 * Share a machine the caller paired with a project (`share: 'project'`, needs
 * the connector-manage capability): everyone in the project can use it,
 * including unattended runs. A private account is not needed: the owner's own
 * account follows them into every project they belong to. `share: 'me'`
 * (the server default) stays accepted and is idempotent.
 */
export function useAddComputerToProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...input }: {
      projectId: string;
      tunnelId: string;
      share?: ConnectorConnectOwner;
    }) => addComputerToProject(projectId, input),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['connections', vars.projectId] });
      queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
    },
  });
}

// ─── Device Auth Hooks ──────────────────────────────────────────────────────

export interface DeviceAuthInfo {
  deviceCode: string;
  machineHostname: string | null;
  /** The project the machine named (`connect --project-id`): approving with
   *  `share: 'project'` also shares the machine with it. `null` when it named
   *  none; absent on older servers. */
  projectId?: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: string;
  createdAt: string;
  /** The caller's existing registration of this machine (same hardware id).
   *  Approving reconnects it: new credential, name, and grants, same accounts.
   *  `null` for a machine new to the caller; absent on older servers. */
  registered?: {
    tunnelId: string;
    name: string;
    capabilities: string[];
    isLive: boolean;
  } | null;
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

/**
 * Approve a pairing request. The machine belongs to the caller and is theirs
 * in every project they are a member of, in their private sessions
 * (`share: 'me'`, the default). `share: 'project'` also shares it with a
 * project (needs the connector-manage capability there): `projectId`, or the
 * project the machine named (`DeviceAuthInfo.projectId`) when it is omitted.
 * Older servers need a project for every approval.
 */
export function useApproveDeviceAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, projectId, share, ...data }: {
      code: string;
      name?: string;
      capabilities?: string[];
      projectId?: string;
      share?: ConnectorConnectOwner;
    }) => {
      // `connectionId` is the computer account created on the project: `null`
      // when the approval named no project, absent on older servers.
      const res = await backendApi.post<{ success: boolean; tunnelId: string; connectionId?: string | null }>(
        `/tunnel/device-auth/${code}/approve`,
        {
          ...data,
          ...(projectId ? { project_id: projectId } : {}),
          ...(share ? { share } : {}),
        },
      );
      if (!res.success) throw new Error(res.error?.message || 'Failed to approve device');
      return res.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.deviceAuth(vars.code) });
      queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
      if (vars.projectId) queryClient.invalidateQueries({ queryKey: ['connections', vars.projectId] });
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

// ─── Retired audit hook ──────────────────────────────────────────────────────

/** @deprecated The API removed this route. Fails with `ENDPOINT_RETIRED`. Removed in the next major. */
export function useTunnelAuditLogs(tunnelId: string, page = 1, _limit = 50) {
  return useRetiredQuery<AuditLogPage>('useTunnelAuditLogs', tunnelKeys.auditLogs(tunnelId, page), !!tunnelId);
}
