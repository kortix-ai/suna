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
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type { EmailInstallation, EmailMode, EmailSenderPolicy, SlackInstallation, SlackMode };

const key = (workspaceId: string | null) =>
  ['channels', 'slack-install', workspaceId ?? 'none'] as const;

export function useSlackInstall(workspaceId: string | null) {
  return useQuery({
    queryKey: key(workspaceId),
    enabled: !!workspaceId,
    staleTime: 30_000,
    queryFn: () => (workspaceId ? getSlackInstallation(workspaceId) : null),
  });
}

interface ConnectInput {
  workspaceId: string;
  bot_token: string;
  signing_secret: string;
}

export function useConnectSlack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, ...body }: ConnectInput) => connectSlack(workspaceId, body),
    onSuccess: (_data, { workspaceId }) => {
      qc.invalidateQueries({ queryKey: key(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspace.connectors(workspaceId) });
    },
  });
}

const modeKey = (workspaceId: string | null) =>
  ['channels', 'slack-mode', workspaceId ?? 'none'] as const;

export function useSlackMode(workspaceId: string | null) {
  return useQuery({
    queryKey: modeKey(workspaceId),
    enabled: !!workspaceId,
    staleTime: 60_000,
    queryFn: () =>
      workspaceId ? getSlackMode(workspaceId) : ({ oauth_available: false, install_url: null } satisfies SlackMode),
  });
}

const manifestKey = (workspaceId: string | null) =>
  ['channels', 'slack-manifest', workspaceId ?? 'none'] as const;

export function useSlackManifest(workspaceId: string | null) {
  return useQuery({
    queryKey: manifestKey(workspaceId),
    enabled: !!workspaceId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!workspaceId) return null;
      const manifest = await getSlackManifest(workspaceId);
      return JSON.stringify(manifest, null, 2);
    },
  });
}

export function useDisconnectSlack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => disconnectSlack(workspaceId),
    onSuccess: (_data, workspaceId) => {
      qc.invalidateQueries({ queryKey: key(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspace.connectors(workspaceId) });
    },
  });
}

const emailKey = (workspaceId: string | null, connectorSlug?: string | null) =>
  ['channels', 'email-install', workspaceId ?? 'none', connectorSlug ?? 'kortix_email'] as const;
const emailModeKey = (workspaceId: string | null) =>
  ['channels', 'email-mode', workspaceId ?? 'none'] as const;

export function useEmailInstall(workspaceId: string | null, connectorSlug?: string | null) {
  return useQuery({
    queryKey: emailKey(workspaceId, connectorSlug),
    enabled: !!workspaceId,
    staleTime: 30_000,
    queryFn: () => (workspaceId ? getEmailInstallation(workspaceId, connectorSlug) : null),
  });
}

export function useEmailMode(workspaceId: string | null) {
  return useQuery({
    queryKey: emailModeKey(workspaceId),
    enabled: !!workspaceId,
    staleTime: 60_000,
    queryFn: () =>
      workspaceId
        ? getEmailMode(workspaceId)
        : ({ provider: 'agentmail', managed_available: false } satisfies EmailMode),
  });
}

interface ConnectEmailInput {
  workspaceId: string;
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
    mutationFn: ({ workspaceId, ...body }: ConnectEmailInput) => connectEmail(workspaceId, body),
    onSuccess: (_data, { workspaceId, connector_slug }) => {
      qc.invalidateQueries({ queryKey: emailKey(workspaceId) });
      qc.invalidateQueries({ queryKey: emailKey(workspaceId, connector_slug) });
      qc.invalidateQueries({ queryKey: qk.workspace.connectors(workspaceId) });
    },
  });
}

export function useDisconnectEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: string | { workspaceId: string; connectorSlug?: string | null }) => {
      const workspaceId = typeof input === 'string' ? input : input.workspaceId;
      const connectorSlug = typeof input === 'string' ? null : input.connectorSlug;
      await disconnectEmail(workspaceId, connectorSlug);
      return { workspaceId, connectorSlug };
    },
    onSuccess: ({ workspaceId, connectorSlug }) => {
      qc.invalidateQueries({ queryKey: emailKey(workspaceId, connectorSlug) });
      qc.invalidateQueries({ queryKey: qk.workspace.connectors(workspaceId) });
    },
  });
}

export function useUpdateEmailPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      connectorSlug,
      sender_policy,
    }: {
      workspaceId: string;
      connectorSlug?: string | null;
      sender_policy: EmailSenderPolicy;
    }) => updateEmailPolicy(workspaceId, connectorSlug, sender_policy),
    onSuccess: (_data, { workspaceId, connectorSlug }) => {
      qc.invalidateQueries({ queryKey: emailKey(workspaceId, connectorSlug) });
      qc.invalidateQueries({ queryKey: qk.workspace.connectors(workspaceId) });
    },
  });
}
