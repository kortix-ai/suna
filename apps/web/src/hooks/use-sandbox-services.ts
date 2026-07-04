'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { useServerStore } from '@/stores/server-store';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listServices,
  listServiceTemplates,
  getServiceLogs,
  serviceAction as sdkServiceAction,
  reconcileServices,
  registerService,
  systemReload,
} from '@kortix/sdk/opencode-client';
import type {
  SandboxServiceStatus,
  SandboxServiceAdapter,
  SandboxServiceScope,
  SandboxService,
  SandboxServiceTemplate,
  RegisterSandboxServicePayload,
  SandboxServiceAction,
  SystemReloadMode,
} from '@kortix/sdk/opencode-client';

// The request/response shapes live in the SDK now (`@kortix/sdk/opencode-client`);
// re-exported here for existing importers.
export type {
  SandboxServiceStatus,
  SandboxServiceAdapter,
  SandboxServiceScope,
  SandboxService,
  SandboxServiceTemplate,
  RegisterSandboxServicePayload,
};
export type ServiceAction = SandboxServiceAction;

const getActiveServerUrl = () => {
  return useServerStore.getState().getActiveServerUrl();
};

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
      return listServices(serverUrl, includeAll);
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
      return listServiceTemplates(serverUrl);
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
      return getServiceLogs(serverUrl, serviceId);
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
      return sdkServiceAction(serverUrl, serviceId, action);
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
      return reconcileServices(serverUrl, reload);
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
      return registerService(serverUrl, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
    },
  });
}

// Reload already has a home in the SDK (`systemReload` in `./client`, backing
// `POST /kortix/services/system/reload`) — reused directly rather than
// duplicated here. It resolves the active runtime URL itself (the same
// zustand state `getActiveServerUrl()` above reads, since
// `@/stores/server-store` is a re-export of `@kortix/sdk/server-store`).
export function useSandboxRuntimeReload() {
  return useMutation({
    mutationFn: ({ mode }: { mode: SystemReloadMode }) => systemReload(mode),
  });
}
