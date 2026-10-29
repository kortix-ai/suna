'use client';

import {
  addEmailDomain,
  connectEmail,
  listEmailDomains,
  verifyEmailDomain,
  connectSlack,
  connectTelegram,
  disconnectEmail,
  disconnectSlack,
  disconnectTelegram,
  getEmailInstallation,
  getEmailMode,
  getSlackInstallation,
  getSlackManifest,
  getSlackMode,
  getTelegramInstallation,
  getChannelUserPhoto,
  listChannelUsers,
  allowChannelUser,
  removeChannelUser,
  dismissChannelAccessRequest,
  updateEmailPolicy,
  type EmailDomain,
  type EmailDomainList,
  type EmailDomainResult,
  type EmailInstallation,
  type EmailMode,
  type EmailSenderPolicy,
  type SlackInstallation,
  type SlackMode,
  type ConnectTelegramInput,
  type TelegramInstallation,
  type ChannelAccessList,
  type ChannelAccessPlatform,
  type ChannelUser,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type {
  EmailDomain,
  EmailDomainList,
  EmailDomainResult,
  EmailInstallation,
  EmailMode,
  EmailSenderPolicy,
  SlackInstallation,
  SlackMode,
  TelegramInstallation,
  ChannelAccessPlatform,
  ChannelUser,
};

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
      qc.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
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
      projectId
        ? getSlackMode(projectId)
        : ({ oauth_available: false, install_url: null } satisfies SlackMode),
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
      qc.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
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
        : ({ provider: 'resend', managed_available: false } satisfies EmailMode),
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
      qc.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    },
  });
}

/** The domains an own Resend API key can create inboxes on. A mutation: it runs when the user enters a key. */
export function useListEmailDomains() {
  return useMutation({
    mutationFn: ({ projectId, apiKey }: { projectId: string; apiKey: string }) =>
      listEmailDomains(projectId, { apiKey }),
  });
}

export function useAddEmailDomain() {
  return useMutation({
    mutationFn: ({ projectId, apiKey, domain }: { projectId: string; apiKey: string; domain: string }) =>
      addEmailDomain(projectId, { apiKey, domain }),
  });
}

export function useVerifyEmailDomain() {
  return useMutation({
    mutationFn: ({ projectId, apiKey, domainId }: { projectId: string; apiKey: string; domainId: string }) =>
      verifyEmailDomain(projectId, { apiKey, domainId }),
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
      qc.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
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
      qc.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    },
  });
}

const installKey = (platform: ChannelAccessPlatform, projectId: string | null) =>
  ['channels', `${platform}-install`, projectId ?? 'none'] as const;
const usersKey = (platform: ChannelAccessPlatform, projectId: string) =>
  ['channels', `${platform}-users`, projectId] as const;
const telegramKey = (projectId: string | null) => installKey('telegram', projectId);
const telegramUsersKey = (projectId: string) => usersKey('telegram', projectId);

/** The project's Telegram bot. Pass null to keep the query off. */
export function useTelegramInstall(projectId: string | null) {
  return useQuery({
    queryKey: telegramKey(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: () => (projectId ? getTelegramInstallation(projectId) : null),
  });
}

export function useConnectTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...body }: { projectId: string } & ConnectTelegramInput) =>
      connectTelegram(projectId, body),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: telegramKey(projectId) });
      // Another bot sees other users: never show the old bot's list.
      qc.removeQueries({ queryKey: telegramUsersKey(projectId) });
      qc.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    },
  });
}

/** Allowed users and access requests, with their names on the platform. Each fetch can call the platform, so enable it only on demand. */
export function useChannelUsers(projectId: string, platform: ChannelAccessPlatform, enabled: boolean) {
  return useQuery({
    queryKey: usersKey(platform, projectId),
    enabled,
    queryFn: () => listChannelUsers(projectId, platform),
  });
}

/** One user's profile photo. Off without a `version`: that user has no photo. */
export function useChannelUserPhoto(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
  version: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['channels', `${platform}-photo`, projectId, userId, version],
    enabled: enabled && !!version,
    // The version is in the key: a new photo is a new key.
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) => getChannelUserPhoto(projectId, platform, userId, version, signal),
  });
}

function useChannelUserMutation(
  platform: ChannelAccessPlatform,
  action: (projectId: string, platform: ChannelAccessPlatform, userId: string) => Promise<ChannelAccessList>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, userId }: { projectId: string; userId: string }) =>
      action(projectId, platform, userId),
    // Returned so the mutation stays pending until the list shows the change.
    onSuccess: (_data, { projectId }) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: installKey(platform, projectId) }),
        qc.invalidateQueries({ queryKey: usersKey(platform, projectId) }),
      ]),
  });
}

export const useAllowChannelUser = (platform: ChannelAccessPlatform) =>
  useChannelUserMutation(platform, allowChannelUser);
export const useRemoveChannelUser = (platform: ChannelAccessPlatform) =>
  useChannelUserMutation(platform, removeChannelUser);
export const useDismissChannelAccessRequest = (platform: ChannelAccessPlatform) =>
  useChannelUserMutation(platform, dismissChannelAccessRequest);

export function useDisconnectTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => disconnectTelegram(projectId),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: telegramKey(projectId) });
      qc.removeQueries({ queryKey: telegramUsersKey(projectId) });
      qc.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    },
  });
}
