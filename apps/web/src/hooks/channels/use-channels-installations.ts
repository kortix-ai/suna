'use client';

import {
  connectEmail,
  connectSlack,
  disconnectEmail,
  disconnectSlack,
  getEmailInstallation,
  getEmailMode,
  getSlackInstallation,
  getSlackManifest,
  getSlackMode,
  updateEmailPolicy,
  type EmailInstallation,
  type EmailMode,
  type EmailSenderPolicy,
  type SlackInstallation,
  type SlackMode,
} from '@kortix/sdk/projects-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type { EmailInstallation, EmailMode, EmailSenderPolicy, SlackInstallation, SlackMode };

const key = (projectId: string | null) =>
  ['channels', 'slack-install', projectId ?? 'none'] as const;

export function useSlackInstall(projectId: string | null) {
  return useQuery({
    queryKey: key(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: () => (projectId ? getSlackInstallation(projectId) : null),
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
    mutationFn: ({ projectId, ...body }: ConnectInput) => connectSlack(projectId, body),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
      qc.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });
}

const modeKey = (projectId: string | null) =>
  ['channels', 'slack-mode', projectId ?? 'none'] as const;

export function useSlackMode(projectId: string | null) {
  return useQuery({
    queryKey: modeKey(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: () =>
      projectId ? getSlackMode(projectId) : ({ oauth_available: false, install_url: null } satisfies SlackMode),
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
      const manifest = await getSlackManifest(projectId);
      return JSON.stringify(manifest, null, 2);
    },
  });
}

export function useDisconnectSlack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => disconnectSlack(projectId),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
      qc.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });
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
    queryFn: () => (projectId ? getEmailInstallation(projectId, connectorSlug) : null),
  });
}

export function useEmailMode(projectId: string | null) {
  return useQuery({
    queryKey: emailModeKey(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: () =>
      projectId
        ? getEmailMode(projectId)
        : ({ provider: 'agentmail', managed_available: false } satisfies EmailMode),
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
    mutationFn: ({ projectId, ...body }: ConnectEmailInput) => connectEmail(projectId, body),
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
      await disconnectEmail(projectId, connectorSlug);
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
    mutationFn: ({
      projectId,
      connectorSlug,
      sender_policy,
    }: {
      projectId: string;
      connectorSlug?: string | null;
      sender_policy: EmailSenderPolicy;
    }) => updateEmailPolicy(projectId, connectorSlug, sender_policy),
    onSuccess: (_data, { projectId, connectorSlug }) => {
      qc.invalidateQueries({ queryKey: emailKey(projectId, connectorSlug) });
      qc.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });
}
