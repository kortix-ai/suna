'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '../core/http/api-client';

export interface TeamsInstallation {
  tenantId: string;
  teamId: string | null;
  teamName: string | null;
  botId: string | null;
  serviceUrl: string | null;
  byo: boolean;
  orgInstalled: boolean;
  catalogAppId: string | null;
  installedAt: string;
}

export interface TeamsMode {
  enabled: boolean;
  available: boolean;
  appId: string | null;
  messagingEndpoint: string | null;
  adminConsentUrl: string | null;
  deepLinkUrl: string | null;
  orgConsentUrl: string | null;
  orgInstalled: boolean;
  byo: boolean;
}

const key = (workspaceId: string | null) =>
  ['channels', 'teams-install', workspaceId ?? 'none'] as const;
const modeKey = (workspaceId: string | null) =>
  ['channels', 'teams-mode', workspaceId ?? 'none'] as const;
const manifestKey = (workspaceId: string | null) =>
  ['channels', 'teams-manifest', workspaceId ?? 'none'] as const;

export function useTeamsInstall(workspaceId: string | null) {
  return useQuery({
    queryKey: key(workspaceId),
    enabled: !!workspaceId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!workspaceId) return null;
      const res = await backendApi.get<TeamsInstallation | null>(
        `/workspaces/${encodeURIComponent(workspaceId)}/channels/teams/installation`,
        { showErrors: false },
      );
      if (!res.success) return null;
      return res.data ?? null;
    },
  });
}

export function useTeamsMode(workspaceId: string | null) {
  return useQuery({
    queryKey: modeKey(workspaceId),
    enabled: !!workspaceId,
    staleTime: 60_000,
    queryFn: async () => {
      const fallback: TeamsMode = {
        enabled: false,
        available: false,
        appId: null,
        messagingEndpoint: null,
        adminConsentUrl: null,
        deepLinkUrl: null,
        orgConsentUrl: null,
        orgInstalled: false,
        byo: false,
      };
      if (!workspaceId) return fallback;
      const res = await backendApi.get<TeamsMode>(
        `/workspaces/${encodeURIComponent(workspaceId)}/channels/teams/mode`,
        { showErrors: false },
      );
      if (!res.success || !res.data) return fallback;
      return res.data;
    },
  });
}

export function useTeamsManifest(workspaceId: string | null) {
  return useQuery({
    queryKey: manifestKey(workspaceId),
    enabled: !!workspaceId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!workspaceId) return null;
      const res = await backendApi.get<Record<string, unknown>>(
        `/workspaces/${encodeURIComponent(workspaceId)}/channels/teams/manifest`,
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? 'Failed to load Teams manifest');
      }
      return JSON.stringify(res.data, null, 2);
    },
  });
}

interface ConnectInput {
  workspaceId: string;
  tenant_id: string;
  team_name?: string;
  app_id?: string;
  app_password?: string;
}

export function useConnectTeams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: ConnectInput) => {
      const res = await backendApi.post<TeamsInstallation>(
        `/workspaces/${encodeURIComponent(workspaceId)}/channels/teams/connect`,
        body,
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? 'Failed to connect');
      }
      return res.data;
    },
    onSuccess: (_data, { workspaceId }) => {
      qc.invalidateQueries({ queryKey: key(workspaceId) });
      qc.invalidateQueries({ queryKey: modeKey(workspaceId) });
      qc.invalidateQueries({ queryKey: manifestKey(workspaceId) });
    },
  });
}

export function useDisconnectTeams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (workspaceId: string) => {
      const res = await backendApi.delete(
        `/workspaces/${encodeURIComponent(workspaceId)}/channels/teams/installation`,
        { showErrors: false },
      );
      if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect');
    },
    onSuccess: (_data, workspaceId) => {
      qc.invalidateQueries({ queryKey: key(workspaceId) });
    },
  });
}
