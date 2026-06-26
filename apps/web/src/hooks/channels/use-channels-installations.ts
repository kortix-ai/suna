'use client';

import { backendApi } from '@/lib/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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
      qc.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });
}

export interface SlackMode {
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

const manifestKey = (projectId: string | null) =>
  ['channels', 'slack-manifest', projectId ?? 'none'] as const;

export function useSlackManifest(projectId: string | null) {
  return useQuery({
    queryKey: manifestKey(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!projectId) return null;
      const res = await backendApi.get<Record<string, unknown>>(
        `/webhooks/slack/${encodeURIComponent(projectId)}/manifest`,
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? 'Failed to load Slack manifest');
      }
      return JSON.stringify(res.data, null, 2);
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
      qc.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });
}

export interface EmailInstallation {
  profileSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: EmailSenderPolicy;
  installedAt: string;
}

export interface EmailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
}

export interface EmailMode {
  provider: 'agentmail';
  enabled?: boolean;
  managed_available: boolean;
}

const emailKey = (projectId: string | null, connectorSlug?: string | null) =>
  ['channels', 'email-install', projectId ?? 'none', connectorSlug ?? 'kortix_email'] as const;
const emailModeKey = (projectId: string | null) =>
  ['channels', 'email-mode', projectId ?? 'none'] as const;

export function useEmailInstall(projectId: string | null, connectorSlug?: string | null) {
  return useQuery({
    queryKey: emailKey(projectId, connectorSlug),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!projectId) return null;
      const query = connectorSlug ? `?connector_slug=${encodeURIComponent(connectorSlug)}` : '';
      const res = await backendApi.get<EmailInstallation | null>(
        `/projects/${encodeURIComponent(projectId)}/channels/email/installation${query}`,
        { showErrors: false },
      );
      if (!res.success) return null;
      return res.data ?? null;
    },
  });
}

export function useEmailMode(projectId: string | null) {
  return useQuery({
    queryKey: emailModeKey(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!projectId) {
        return { provider: 'agentmail', managed_available: false } satisfies EmailMode;
      }
      const res = await backendApi.get<EmailMode>(
        `/projects/${encodeURIComponent(projectId)}/channels/email/mode`,
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        return { provider: 'agentmail', managed_available: false } satisfies EmailMode;
      }
      return res.data;
    },
  });
}

interface ConnectEmailInput {
  projectId: string;
  connector_slug?: string;
  api_key?: string;
  display_name?: string;
  username?: string;
  domain?: string;
  inbox_id?: string;
  email?: string;
  sender_policy?: EmailSenderPolicy;
}

export function useConnectEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, ...body }: ConnectEmailInput) => {
      const res = await backendApi.post<EmailInstallation>(
        `/projects/${encodeURIComponent(projectId)}/channels/email/connect`,
        body,
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? 'Failed to connect email');
      }
      return res.data;
    },
    onSuccess: (_data, { projectId, connector_slug }) => {
      qc.invalidateQueries({ queryKey: emailKey(projectId) });
      qc.invalidateQueries({ queryKey: emailKey(projectId, connector_slug) });
      qc.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });
}

export function useDisconnectEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: string | { projectId: string; connectorSlug?: string | null }) => {
      const projectId = typeof input === 'string' ? input : input.projectId;
      const connectorSlug = typeof input === 'string' ? null : input.connectorSlug;
      const query = connectorSlug ? `?connector_slug=${encodeURIComponent(connectorSlug)}` : '';
      const res = await backendApi.delete(
        `/projects/${encodeURIComponent(projectId)}/channels/email/installation${query}`,
        { showErrors: false },
      );
      if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect email');
      return { projectId, connectorSlug };
    },
    onSuccess: ({ projectId, connectorSlug }) => {
      qc.invalidateQueries({ queryKey: emailKey(projectId, connectorSlug) });
      qc.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });
}

export function useUpdateEmailPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      connectorSlug,
      sender_policy,
    }: {
      projectId: string;
      connectorSlug?: string | null;
      sender_policy: EmailSenderPolicy;
    }) => {
      const res = await backendApi.patch<EmailInstallation>(
        `/projects/${encodeURIComponent(projectId)}/channels/email/installation`,
        { connector_slug: connectorSlug ?? 'kortix_email', sender_policy },
        { showErrors: false },
      );
      if (!res.success || !res.data)
        throw new Error(res.error?.message ?? 'Failed to update email policy');
      return res.data;
    },
    onSuccess: (_data, { projectId, connectorSlug }) => {
      qc.invalidateQueries({ queryKey: emailKey(projectId, connectorSlug) });
      qc.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });
}
