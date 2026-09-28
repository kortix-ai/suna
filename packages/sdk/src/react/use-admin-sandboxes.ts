import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { backendApi } from '../core/http/api-client';
import { retiredEndpointError } from '../core/http/api/errors';
import { useRetiredMutation, useRetiredQuery } from './retired-endpoint';

export interface AdminSandbox {
  sandboxId: string;
  accountId: string | null;
  name: string | null;
  provider: string | null;
  externalId: string | null;
  status: string | null;
  baseUrl: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  accountName: string | null;
  ownerEmail: string | null;
  initStatus?: 'pending' | 'provisioning' | 'retrying' | 'ready' | 'failed';
  healthStatus?: 'healthy' | 'degraded' | 'offline' | 'unknown';
  initAttempts?: number;
  lastInitError?: string | null;
}

export interface AdminSandboxesParams {
  search?: string;
  status?: string;
  provider?: string;
  page?: number;
  limit?: number;
}

interface AdminSandboxesResponse {
  sandboxes: AdminSandbox[];
  total: number;
  page: number;
  limit: number;
  error?: string;
}

export function useAdminSandboxes(
  params: AdminSandboxesParams = {},
  options?: Partial<UseQueryOptions<AdminSandboxesResponse>>,
) {
  const { search = '', status = '', provider = '', page = 1, limit = 50 } = params;

  return useQuery<AdminSandboxesResponse>({
    queryKey: ['admin', 'sandboxes', search, status, provider, page, limit],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (search)   q.set('search', search);
      if (status)   q.set('status', status);
      if (provider) q.set('provider', provider);
      q.set('page', String(page));
      q.set('limit', String(limit));

      const response = await backendApi.get<AdminSandboxesResponse>(
        `/admin/api/sandboxes?${q.toString()}`
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: 15_000,
    placeholderData: (prev) => prev, // keep previous data while fetching next page
    ...options,
  });
}

export interface AdminSandboxDetail {
  sandbox: AdminSandbox & { config: unknown };
  provider_detail: ProviderMachineDetail | null;
  provider_error: string | null;
}

export type AdminInstanceLayerStatus = 'healthy' | 'degraded' | 'offline' | 'unknown';

export interface AdminInstanceLayerAction {
  action: 'start_host' | 'reboot_host' | 'stop_host' | 'start_workload' | 'restart_workload' | 'stop_workload' | 'reinitialize' | 'restart_runtime' | 'restart_service';
  label: string;
  serviceId?: string;
}

export interface AdminInstanceLayerHealth {
  key: 'host' | 'workload' | 'runtime';
  label: string;
  status: AdminInstanceLayerStatus;
  summary: string;
  actions: AdminInstanceLayerAction[];
  details: Record<string, unknown>;
}

export interface AdminSandboxHealth {
  sandbox_id: string;
  overall_status: 'healthy' | 'degraded' | 'offline' | 'unknown';
  recommended_action: AdminInstanceLayerAction['action'] | null;
  last_heartbeat_at?: string | null;
  layers: {
    host: AdminInstanceLayerHealth;
    workload: AdminInstanceLayerHealth;
    runtime: AdminInstanceLayerHealth;
  };
}

export interface AdminSandboxHealthBatchResponse {
  items: AdminSandboxHealth[];
}

export interface ProviderMachineDetail {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  provisioning_stage: string | null;
  provider: string;
  server_type: string | null;
  region: string | null;
  ip: string | null;
  daemon_version: string | null;
  created_at: string;
  ready_at: string | null;
  last_heartbeat_at?: string | null;
  health: {
    cpu?: number;
    memory?: number;
    disk?: number;
    services?: Record<string, boolean>;
    network?: { rate_in?: number; rate_out?: number; connections?: number };
    security?: { ufw_active?: boolean; fail2ban_active?: boolean; ssh_key_only?: boolean };
    last_heartbeat_at?: string | null;
  } | null;
  urls?: { proxy?: string; terminal?: string } | null;
  ssh?: { command?: string | null; setup_command?: string | null } | null;
  connect?: { ssh_command?: string | null; setup_command?: string | null; vscode_url?: string | null } | null;
  ssh_key?: { setup_command?: string | null; key_path?: string | null } | null;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAdminSandboxDetail(sandboxId: string | null) {
  return useRetiredQuery<AdminSandboxDetail>('useAdminSandboxDetail', ['admin', 'sandbox-detail', sandboxId], !!sandboxId);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAdminSandboxHealth(sandboxId: string | null, enabled = true) {
  return useRetiredQuery<AdminSandboxHealth>('useAdminSandboxHealth', ['admin', 'sandbox-health', sandboxId], !!sandboxId && enabled);
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAdminSandboxHealthBatch(sandboxIds: string[], enabled = true) {
  return useRetiredQuery<AdminSandboxHealthBatchResponse>('useAdminSandboxHealthBatch', ['admin', 'sandbox-health-batch', sandboxIds], enabled && sandboxIds.length > 0);
}

export interface ExecResult {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  duration_ms?: number;
  error?: string;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAdminSandboxExec() {
  return useRetiredMutation<ExecResult, { sandboxId: string; command: string; timeout?: number }>('useAdminSandboxExec');
}

export interface ProxyTokenResult {
  token: string;
  token_id: string;
  expires_at: number;
  terminal_url: string | null;
  proxy_url: string | null;
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export async function fetchAdminSandboxProxyToken(_sandboxId: string): Promise<ProxyTokenResult> {
  throw retiredEndpointError('fetchAdminSandboxProxyToken');
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAdminSandboxAction() {
  return useRetiredMutation<unknown, { sandboxId: string; action: 'reboot' | 'stop' | 'start' }>('useAdminSandboxAction');
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useAdminSandboxRepair() {
  return useRetiredMutation<unknown, { sandboxId: string; action: AdminInstanceLayerAction['action']; serviceId?: string }>('useAdminSandboxRepair');
}

/** @deprecated The API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. */
export function useDeleteAdminSandbox() {
  return useRetiredMutation<{ success: boolean; sandboxId: string }, string>('useDeleteAdminSandbox');
}
