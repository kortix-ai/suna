'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { authenticatedFetch } from '@/lib/auth-token';
import { useServerStore } from '@/stores/server-store';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type SandboxServiceStatus = 'running' | 'stopped' | 'starting' | 'failed' | 'backoff';
export type SandboxServiceAdapter = 'spawn' | 's6';
export type SandboxServiceScope = 'bootstrap' | 'core' | 'project' | 'session';

export interface SandboxService {
  id: string;
  name: string;
  port: number;
  pid: number;
  framework: string;
  sourcePath: string;
  startedAt: string;
  status: SandboxServiceStatus;
  managed: boolean;
  adapter?: SandboxServiceAdapter;
  scope?: SandboxServiceScope;
  desiredState?: 'running' | 'stopped';
  builtin?: boolean;
  autoStart?: boolean;
}

export interface SandboxServiceTemplate {
  id: string;
  name: string;
  description: string;
  adapter: SandboxServiceAdapter;
  framework?: string;
  startCommand?: string;
  installCommand?: string | null;
  buildCommand?: string | null;
  defaultPort?: number;
}

export interface RegisterSandboxServicePayload {
  id: string;
  name?: string;
  adapter?: SandboxServiceAdapter;
  scope?: SandboxServiceScope;
  description?: string;
  projectId?: string | null;
  template?: string | null;
  framework?: string | null;
  sourcePath?: string | null;
  startCommand?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  envVarKeys?: string[];
  deps?: string[];
  port?: number | null;
  desiredState?: 'running' | 'stopped';
  autoStart?: boolean;
  restartPolicy?: 'always' | 'on-failure' | 'never';
  restartDelayMs?: number;
  s6ServiceName?: string | null;
  processPatterns?: string[];
  userVisible?: boolean;
  healthCheck?: {
    type?: 'none' | 'tcp' | 'http';
    path?: string;
    timeoutMs?: number;
  };
  startNow?: boolean;
}

type ServiceAction = 'start' | 'stop' | 'restart' | 'delete';
type RuntimeReloadMode = 'dispose-only' | 'full';

const getActiveServerUrl = () => {
  return useServerStore.getState().getActiveServerUrl();
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(
    url,
    {
      signal: AbortSignal.timeout(10_000),
      ...init,
    },
    { retryOnAuthError: false },
  );

  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.error || data.details || `Request failed with status ${response.status}`);
  }

  return data as T;
}

export const serviceKeys = {
  all: ['sandbox-services'] as const,
  list: (serverUrl: string, includeAll: boolean) =>
    ['sandbox-services', serverUrl, includeAll ? 'all' : 'visible'] as const,
  logs: (serverUrl: string, serviceId: string) =>
    ['sandbox-services', serverUrl, 'logs', serviceId] as const,
  templates: (serverUrl: string) => ['sandbox-services', serverUrl, 'templates'] as const,
};

export function useSandboxServices(options?: { enabled?: boolean; includeAll?: boolean }) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  const includeAll = options?.includeAll ?? false;

  return useQuery<SandboxService[]>({
    queryKey: [...serviceKeys.list(serverUrl, includeAll), user?.id ?? 'anonymous'],
    queryFn: async () => {
      if (!serverUrl) return [];
      const query = includeAll ? '?all=true' : '';
      const data = await requestJson<{ services?: SandboxService[] }>(
        `${serverUrl}/kortix/services${query}`,
      );
      return data.services ?? [];
    },
    enabled: (options?.enabled ?? true) && !isAuthLoading && !!user && !!serverUrl,
    staleTime: 5_000,
    gcTime: 60_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useSandboxServiceTemplates(options?: { enabled?: boolean }) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<SandboxServiceTemplate[]>({
    queryKey: [...serviceKeys.templates(serverUrl), user?.id ?? 'anonymous'],
    queryFn: async () => {
      if (!serverUrl) return [];
      const data = await requestJson<{ templates?: SandboxServiceTemplate[] }>(
        `${serverUrl}/kortix/services/templates`,
      );
      return data.templates ?? [];
    },
    enabled: (options?.enabled ?? true) && !isAuthLoading && !!user && !!serverUrl,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}

export function useSandboxServiceLogs(serviceId: string | null, options?: { enabled?: boolean }) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<string[]>({
    queryKey: serviceId
      ? [...serviceKeys.logs(serverUrl, serviceId), user?.id ?? 'anonymous']
      : ['sandbox-services', serverUrl, 'logs', 'none', user?.id ?? 'anonymous'],
    queryFn: async () => {
      if (!serverUrl || !serviceId) return [];
      const data = await requestJson<{ logs?: string[] }>(
        `${serverUrl}/kortix/services/${encodeURIComponent(serviceId)}/logs`,
      );
      return data.logs ?? [];
    },
    enabled: (options?.enabled ?? true) && !isAuthLoading && !!user && !!serverUrl && !!serviceId,
    staleTime: 3_000,
    gcTime: 60_000,
    refetchInterval: serviceId ? 3_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useSandboxServiceAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ serviceId, action }: { serviceId: string; action: ServiceAction }) => {
      const serverUrl = getActiveServerUrl();
      if (!serverUrl) throw new Error('No active instance selected');

      const isDelete = action === 'delete';
      const method = isDelete ? 'DELETE' : 'POST';
      const path = isDelete
        ? `${serverUrl}/kortix/services/${encodeURIComponent(serviceId)}`
        : `${serverUrl}/kortix/services/${encodeURIComponent(serviceId)}/${action}`;

      return requestJson(path, { method });
    },
    onSuccess: () => {
      const serverUrl = getActiveServerUrl();
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
      if (serverUrl) {
        queryClient.invalidateQueries({ queryKey: serviceKeys.templates(serverUrl) });
      }
    },
  });
}

export function useSandboxServiceReconcile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ reload }: { reload?: boolean } = {}) => {
      const serverUrl = getActiveServerUrl();
      if (!serverUrl) throw new Error('No active instance selected');
      const url = `${serverUrl}/kortix/services/reconcile${reload ? '?reload=true' : ''}`;
      return requestJson(url, { method: 'POST' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
    },
  });
}

export function useRegisterSandboxService() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: RegisterSandboxServicePayload) => {
      const serverUrl = getActiveServerUrl();
      if (!serverUrl) throw new Error('No active instance selected');
      return requestJson<{ success: boolean; output?: string; service?: SandboxService }>(
        `${serverUrl}/kortix/services/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
    },
  });
}

export function useSandboxRuntimeReload() {
  return useMutation({
    mutationFn: async ({ mode }: { mode: RuntimeReloadMode }) => {
      const serverUrl = getActiveServerUrl();
      if (!serverUrl) throw new Error('No active instance selected');
      return requestJson<{
        success: boolean;
        mode: RuntimeReloadMode;
        steps: string[];
        errors: string[];
      }>(`${serverUrl}/kortix/services/system/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    },
  });
}
