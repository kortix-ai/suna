import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

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

export function useAdminSandboxDetail(sandboxId: string | null) {
  return useQuery<AdminSandboxDetail>({
    queryKey: ['admin', 'sandbox-detail', sandboxId],
    enabled: !!sandboxId,
    queryFn: async () => {
      const response = await backendApi.get<AdminSandboxDetail>(`/admin/api/sandboxes/${sandboxId}`);
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    refetchInterval: 10_000,
  });
}

export interface ExecResult {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  duration_ms?: number;
  error?: string;
}

export function useAdminSandboxExec() {
  return useMutation<ExecResult, Error, { sandboxId: string; command: string; timeout?: number }>({
    mutationFn: async ({ sandboxId, command, timeout }) => {
      const response = await backendApi.post<ExecResult>(
        `/admin/api/sandboxes/${sandboxId}/exec`,
        { command, timeout: timeout ?? 60 },
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
}

export interface ProxyTokenResult {
  token: string;
  token_id: string;
  expires_at: number;
  terminal_url: string | null;
  proxy_url: string | null;
}

export async function fetchAdminSandboxProxyToken(sandboxId: string): Promise<ProxyTokenResult> {
  const response = await backendApi.post<ProxyTokenResult>(`/admin/api/sandboxes/${sandboxId}/proxy-token`);
  if (response.error) throw new Error(response.error.message);
  return response.data!;
}

export function useAdminSandboxAction() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { sandboxId: string; action: 'reboot' | 'stop' | 'start' }>({
    mutationFn: async ({ sandboxId, action }) => {
      const response = await backendApi.post(`/admin/api/sandboxes/${sandboxId}/action`, { action });
      if (response.error) throw new Error(response.error.message);
      return response.data;
    },
    onSuccess: (_data, { sandboxId }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'sandboxes'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'sandbox-detail', sandboxId] });
    },
  });
}

export function useDeleteAdminSandbox() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; sandboxId: string }, Error, string>({
    mutationFn: async (sandboxId: string) => {
      const response = await backendApi.delete<{ success: boolean; sandboxId: string }>(
        `/admin/api/sandboxes/${sandboxId}`
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'sandboxes'] });
    },
  });
}
