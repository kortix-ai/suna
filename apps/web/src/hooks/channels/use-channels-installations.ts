'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface SlackInstallation {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

const key = (projectId: string | null) =>
  ['channels', 'slack-install', projectId ?? 'none'] as const;

export function useSlackInstall(projectId: string | null) {
  return useQuery({
    queryKey: key(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!projectId) return null;
      const res = await backendApi.get<SlackInstallation | null>(
        `/projects/${encodeURIComponent(projectId)}/channels/slack/installation`,
        { showErrors: false },
      );
      if (!res.success) return null;
      return res.data ?? null;
    },
  });
}

interface ConnectInput {
  projectId: string;
  bot_token: string;
  signing_secret: string;
}

export function useConnectSlack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, ...body }: ConnectInput) => {
      const res = await backendApi.post<SlackInstallation>(
        `/projects/${encodeURIComponent(projectId)}/channels/slack/connect`,
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
    },
  });
}

interface SlackMode {
  oauth_available: boolean;
  install_url: string | null;
}

const modeKey = (projectId: string | null) =>
  ['channels', 'slack-mode', projectId ?? 'none'] as const;

export function useSlackMode(projectId: string | null) {
  return useQuery({
    queryKey: modeKey(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!projectId) return { oauth_available: false, install_url: null } satisfies SlackMode;
      const res = await backendApi.get<SlackMode>(
        `/projects/${encodeURIComponent(projectId)}/channels/slack/mode`,
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        return { oauth_available: false, install_url: null } satisfies SlackMode;
      }
      return res.data;
    },
  });
}

export function useDisconnectSlack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) => {
      const res = await backendApi.delete(
        `/projects/${encodeURIComponent(projectId)}/channels/slack/installation`,
        { showErrors: false },
      );
      if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect');
    },
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}
