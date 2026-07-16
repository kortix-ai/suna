'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

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

const key = (projectId: string | null) =>
  ['channels', 'teams-install', projectId ?? 'none'] as const;
const modeKey = (projectId: string | null) =>
  ['channels', 'teams-mode', projectId ?? 'none'] as const;
const manifestKey = (projectId: string | null) =>
  ['channels', 'teams-manifest', projectId ?? 'none'] as const;

export function useTeamsInstall(projectId: string | null) {
  return useQuery({
    queryKey: key(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!projectId) return null;
      const res = await backendApi.get<TeamsInstallation | null>(
        `/projects/${encodeURIComponent(projectId)}/channels/teams/installation`,
        { showErrors: false },
      );
      if (!res.success) return null;
      return res.data ?? null;
    },
  });
}

export function useTeamsMode(projectId: string | null) {
  return useQuery({
    queryKey: modeKey(projectId),
    enabled: !!projectId,
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
      if (!projectId) return fallback;
      const res = await backendApi.get<TeamsMode>(
        `/projects/${encodeURIComponent(projectId)}/channels/teams/mode`,
        { showErrors: false },
      );
      if (!res.success || !res.data) return fallback;
      return res.data;
    },
  });
}

export function useTeamsManifest(projectId: string | null) {
  return useQuery({
    queryKey: manifestKey(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!projectId) return null;
      const res = await backendApi.get<Record<string, unknown>>(
        `/projects/${encodeURIComponent(projectId)}/channels/teams/manifest`,
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
  projectId: string;
  tenant_id: string;
  team_name?: string;
  app_id?: string;
  app_password?: string;
}

export function useConnectTeams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, ...body }: ConnectInput) => {
      const res = await backendApi.post<TeamsInstallation>(
        `/projects/${encodeURIComponent(projectId)}/channels/teams/connect`,
        body,
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? 'Failed to connect');
      }
      return res.data;
    },
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
      qc.invalidateQueries({ queryKey: modeKey(projectId) });
      qc.invalidateQueries({ queryKey: manifestKey(projectId) });
    },
  });
}

export function useDisconnectTeams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) => {
      const res = await backendApi.delete(
        `/projects/${encodeURIComponent(projectId)}/channels/teams/installation`,
        { showErrors: false },
      );
      if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect');
    },
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}
