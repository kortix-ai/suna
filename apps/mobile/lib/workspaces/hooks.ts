/**
 * Workspaces React Query hooks — web-aligned.
 * Query keys mirror the web app: ['accounts'] and ['workspaces', accountId].
 */

import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveWorkspace,
  buildSandboxTemplate,
  closeChangeRequest,
  createAccount,
  connectSlack,
  createWorkspaceSession,
  createWorkspaceTrigger,
  createSandboxTemplate,
  deleteConnector,
  deleteSandboxTemplate,
  fixSandboxWithAgent,
  listWorkspaceSnapshots,
  rebuildWorkspaceSnapshot,
  updateSandboxTemplate,
  deletePersonalWorkspaceSecret,
  deleteWorkspaceSecret,
  deleteWorkspaceTrigger,
  disconnectConnector,
  disconnectSlack,
  fireWorkspaceTrigger,
  getChangeRequest,
  getChangeRequestDiff,
  getChangeRequestMergePreview,
  getSlackInstallation,
  getSlackMode,
  getWorkspace,
  getWorkspaceDetail,
  getWorkspaceLlmCatalog,
  getWorkspaceCommitDiff,
  getWorkspaceFileHistory,
  getVersionDiff,
  linkRepository,
  listAccounts,
  listChangeRequests,
  listConnectors,
  listGitHubInstallations,
  listGitHubRepositories,
  listPipedreamApps,
  listWorkspaceAccess,
  listWorkspaceBranches,
  listWorkspaceFiles,
  listWorkspacePolicies,
  listWorkspaceSecrets,
  listWorkspaceSessions,
  listWorkspaceTriggers,
  listWorkspacesForAccount,
  mergeChangeRequest,
  openChangeRequest,
  patchChangeRequest,
  provisionWorkspace,
  readWorkspaceFile,
  reopenChangeRequest,
  setPersonalWorkspaceSecret,
  setWorkspacePolicies,
  syncConnectors,
  updateFeatureFlag,
  updateWorkspace,
  updateWorkspaceTrigger,
  upsertWorkspaceSecret,
  inviteWorkspaceMember,
  updateWorkspaceAccess,
  revokeWorkspaceAccess,
  listPendingWorkspaceInvites,
  resendPendingWorkspaceInvite,
  revokePendingWorkspaceInvite,
  listWorkspaceGroupGrants,
  attachGroupToWorkspace,
  updateWorkspaceGroupGrant,
  detachGroupFromWorkspace,
  listAccountGroups,
  removeGroupMember,
  type ChangeRequestStatus,
  type FeatureFlagKey,
  type WorkspaceRole,
  type CreateWorkspaceSessionInput,
  type CreateWorkspaceTriggerInput,
  type CreateSandboxTemplateInput,
  type OpenChangeRequestInput,
  type PolicyDefaultMode,
  type ProvisionWorkspaceInput,
  type WorkspacePolicy,
  type UpdateWorkspaceTriggerInput,
  type UpdateSandboxTemplateInput,
} from './workspaces-client';
import { invalidateAfterWorkspaceCreation } from './workspace-mutation-cache';
import { filterTriggerAgents, flattenTriggerModelCatalog } from './trigger-picker-options';

export type { TriggerAgentOption, TriggerModelOption } from './trigger-picker-options';

export const workspaceKeys = {
  accounts: ['accounts'] as const,
  workspaces: (accountId: string | null | undefined) => ['workspaces', accountId] as const,
  workspace: (workspaceId: string | null | undefined) => ['workspace', workspaceId] as const,
  workspaceDetail: (workspaceId: string | null | undefined) => ['workspace-detail', workspaceId] as const,
  llmCatalog: (workspaceId: string | null | undefined) => ['workspace-llm-catalog', workspaceId] as const,
  workspaceFile: (workspaceId: string | null | undefined, path: string | null | undefined) =>
    ['workspace-file', workspaceId, path] as const,
  workspaceSessions: (workspaceId: string | null | undefined) =>
    ['workspace-sessions', workspaceId] as const,
  connectors: (workspaceId: string | null | undefined) => ['workspace-connectors', workspaceId] as const,
  secrets: (workspaceId: string | null | undefined) => ['workspace-secrets', workspaceId] as const,
  slackInstall: (workspaceId: string | null | undefined) => ['slack-install', workspaceId] as const,
  slackMode: (workspaceId: string | null | undefined) => ['slack-mode', workspaceId] as const,
  triggers: (workspaceId: string | null | undefined) => ['workspace-triggers', workspaceId] as const,
  changeRequests: (workspaceId: string | null | undefined, status: string) =>
    ['change-requests', workspaceId, status] as const,
  changeRequest: (workspaceId: string | null | undefined, crId: string | null | undefined) =>
    ['change-request', workspaceId, crId] as const,
  changeRequestDiff: (workspaceId: string | null | undefined, crId: string | null | undefined) =>
    ['change-request-diff', workspaceId, crId] as const,
  changeRequestMergePreview: (
    workspaceId: string | null | undefined,
    crId: string | null | undefined
  ) => ['change-request-merge-preview', workspaceId, crId] as const,
  branches: (workspaceId: string | null | undefined) => ['workspace-branches', workspaceId] as const,
  workspaceFiles: (workspaceId: string | null | undefined, ref: string) =>
    ['workspace-files', workspaceId, ref] as const,
  workspaceFileContent: (
    workspaceId: string | null | undefined,
    path: string | null | undefined,
    ref: string
  ) => ['workspace-file-content', workspaceId, path, ref] as const,
  workspaceFileHistory: (
    workspaceId: string | null | undefined,
    path: string | null | undefined,
    ref: string
  ) => ['workspace-file-history', workspaceId, path, ref] as const,
  workspaceCommitDiff: (
    workspaceId: string | null | undefined,
    sha: string | null | undefined,
    path: string
  ) => ['workspace-commit-diff', workspaceId, sha, path] as const,
  snapshots: (workspaceId: string | null | undefined) => ['workspace-snapshots', workspaceId] as const,
  versionDiff: (workspaceId: string | null | undefined, from: string, into: string) =>
    ['version-diff', workspaceId, from, into] as const,
  workspaceAccess: (workspaceId: string | null | undefined) => ['workspace-access', workspaceId] as const,
  pendingInvites: (workspaceId: string | null | undefined) =>
    ['workspace-pending-invites', workspaceId] as const,
  groupGrants: (workspaceId: string | null | undefined) =>
    ['workspace-group-grants', workspaceId] as const,
  accountGroups: (accountId: string | null | undefined) => ['account-groups', accountId] as const,
  policies: (workspaceId: string | null | undefined) => ['workspace-policies', workspaceId] as const,
  pipedreamApps: (workspaceId: string | null | undefined, q: string) =>
    ['pipedream-apps', workspaceId, q] as const,
  pipedreamAppMeta: (workspaceId: string | null | undefined, slug: string | null | undefined) =>
    ['pipedream-app-meta', workspaceId, slug] as const,
  githubInstallations: (accountId: string | null | undefined) =>
    ['github-installations', accountId] as const,
  githubRepositories: (
    accountId: string | null | undefined,
    installationId: string | null | undefined
  ) => ['github-repositories', accountId, installationId] as const,
};

export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: workspaceKeys.accounts,
    queryFn: listAccounts,
    enabled,
    staleTime: 60_000,
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createAccount(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useWorkspaces(accountId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.workspaces(accountId),
    queryFn: () => listWorkspacesForAccount(accountId || undefined),
    enabled: !!accountId,
    staleTime: 20_000,
  });
}

export function useWorkspace(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.workspace(workspaceId),
    queryFn: () => getWorkspace(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 20_000,
  });
}

// ── Settings (web parity: customize/sections/settings-view) ───────────────────

/** Patch workspace fields (name / default branch / manifest path). */
export function useUpdateWorkspace(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; default_branch?: string; manifest_path?: string }) =>
      updateWorkspace(workspaceId, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(workspaceKeys.workspace(workspaceId), updated);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

/** Toggle an experimental / WIP feature for this Workspace. */
export function useUpdateFeatureFlag(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      feature,
      enabled,
    }: {
      feature: FeatureFlagKey;
      enabled: boolean | null;
    }) => updateFeatureFlag(workspaceId, feature, enabled),
    onSuccess: (updated) => {
      queryClient.setQueryData(workspaceKeys.workspace(workspaceId), updated);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.workspaceDetail(workspaceId) });
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

/** Workspace config summary — agents, skills, commands (web parity). */
export function useWorkspaceDetail(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.workspaceDetail(workspaceId),
    queryFn: () => getWorkspaceDetail(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

/** Read a repo file's content (config source views). */
export function useWorkspaceFile(workspaceId: string | null, path: string | null) {
  return useQuery({
    queryKey: workspaceKeys.workspaceFile(workspaceId, path),
    queryFn: () => readWorkspaceFile(workspaceId!, path!),
    enabled: !!workspaceId && !!path,
    staleTime: 30_000,
  });
}

// ── Connectors (web parity) ──────────────────────────────────────────────────

/** Connected tool connectors for a Workspace. */
export function useConnectors(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.connectors(workspaceId),
    queryFn: () => listConnectors(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 15_000,
  });
}

/** Re-index connector actions from their providers. */
export function useSyncConnectors(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncConnectors(workspaceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.connectors(workspaceId) }),
  });
}

/** Remove a connector. */
export function useDeleteConnector(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => deleteConnector(workspaceId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.connectors(workspaceId) }),
  });
}

/** Disconnect a connector — remove its credential but keep the connector. */
export function useDisconnectConnector(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => disconnectConnector(workspaceId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.connectors(workspaceId) }),
  });
}

/** Tool-approval policies for a Workspace. */
export function useWorkspacePolicies(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.policies(workspaceId),
    queryFn: () => listWorkspacePolicies(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 15_000,
  });
}

export function useSetWorkspacePolicies(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      policies,
      defaultMode,
    }: {
      policies: WorkspacePolicy[];
      defaultMode: PolicyDefaultMode;
    }) => setWorkspacePolicies(workspaceId, policies, defaultMode),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.policies(workspaceId) }),
  });
}

/** Workspace members (for the Members page). */
export function useWorkspaceAccess(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.workspaceAccess(workspaceId),
    queryFn: () => listWorkspaceAccess(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

// ── Members (web parity: customize/sections/members-view) ─────────────────────

export function usePendingWorkspaceInvites(workspaceId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: workspaceKeys.pendingInvites(workspaceId),
    queryFn: () => listPendingWorkspaceInvites(workspaceId!),
    enabled: enabled && !!workspaceId,
    staleTime: 5_000,
  });
}

export function useWorkspaceGroupGrants(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.groupGrants(workspaceId),
    queryFn: () => listWorkspaceGroupGrants(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 20_000,
  });
}

export function useAccountGroups(accountId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: workspaceKeys.accountGroups(accountId),
    queryFn: () => listAccountGroups(accountId!),
    enabled: enabled && !!accountId,
    staleTime: 60_000,
  });
}

/** Invalidate everything that a membership/group change can ripple into. */
function useInvalidateMembership(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: workspaceKeys.workspaceAccess(workspaceId) });
    queryClient.invalidateQueries({ queryKey: workspaceKeys.groupGrants(workspaceId) });
    queryClient.invalidateQueries({ queryKey: workspaceKeys.workspace(workspaceId) });
    queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  };
}

export function useInviteWorkspaceMember(workspaceId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateMembership(workspaceId);
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: WorkspaceRole }) =>
      inviteWorkspaceMember(workspaceId, email, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.pendingInvites(workspaceId) });
      invalidate();
    },
  });
}

export function useUpdateWorkspaceAccess(workspaceId: string) {
  const invalidate = useInvalidateMembership(workspaceId);
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      updateWorkspaceAccess(workspaceId, userId, role),
    onSuccess: invalidate,
  });
}

export function useRevokeWorkspaceAccess(workspaceId: string) {
  const invalidate = useInvalidateMembership(workspaceId);
  return useMutation({
    mutationFn: (userId: string) => revokeWorkspaceAccess(workspaceId, userId),
    onSuccess: invalidate,
  });
}

export function useResendWorkspaceInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => resendPendingWorkspaceInvite(workspaceId, inviteId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.pendingInvites(workspaceId) }),
  });
}

export function useRevokeWorkspaceInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => revokePendingWorkspaceInvite(workspaceId, inviteId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.pendingInvites(workspaceId) }),
  });
}

export function useAttachGroup(workspaceId: string) {
  const invalidate = useInvalidateMembership(workspaceId);
  return useMutation({
    mutationFn: ({ groupId, role }: { groupId: string; role: WorkspaceRole }) =>
      attachGroupToWorkspace(workspaceId, groupId, role),
    onSuccess: invalidate,
  });
}

export function useUpdateGroupGrant(workspaceId: string) {
  const invalidate = useInvalidateMembership(workspaceId);
  return useMutation({
    mutationFn: ({ groupId, role }: { groupId: string; role: WorkspaceRole }) =>
      updateWorkspaceGroupGrant(workspaceId, groupId, role),
    onSuccess: invalidate,
  });
}

export function useDetachGroup(workspaceId: string) {
  const invalidate = useInvalidateMembership(workspaceId);
  return useMutation({
    mutationFn: (groupId: string) => detachGroupFromWorkspace(workspaceId, groupId),
    onSuccess: invalidate,
  });
}

export function useRemoveGroupMember(workspaceId: string, accountId: string | null) {
  const invalidate = useInvalidateMembership(workspaceId);
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      removeGroupMember(accountId ?? '', groupId, userId),
    onSuccess: invalidate,
  });
}

/** Resolve a single Pipedream app's display name + logo by its slug, for showing
 *  connected connectors with their real app branding. Cached; lazy per row. */
export function usePipedreamAppMeta(workspaceId: string | null, slug: string | null, enabled = true) {
  return useQuery({
    queryKey: workspaceKeys.pipedreamAppMeta(workspaceId, slug),
    queryFn: async () => {
      const page = await listPipedreamApps(workspaceId!, slug || undefined);
      return page.apps.find((a) => a.slug === slug) ?? page.apps[0] ?? null;
    },
    enabled: enabled && !!workspaceId && !!slug,
    staleTime: 5 * 60_000,
  });
}

/** Searchable, paginated Pipedream app catalogue (Easy Connect). */
export function usePipedreamApps(workspaceId: string | null, q: string) {
  return useInfiniteQuery({
    queryKey: workspaceKeys.pipedreamApps(workspaceId, q),
    queryFn: ({ pageParam }) => listPipedreamApps(workspaceId!, q || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

export function useWorkspaceSessions(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.workspaceSessions(workspaceId),
    queryFn: () => listWorkspaceSessions(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 10_000,
    // Poll so freshly-provisioning session sandboxes flip to running in the list.
    refetchInterval: (query) => {
      const data = query.state.data;
      const pending = data?.some((s) => ['queued', 'branching', 'provisioning'].includes(s.status));
      return pending ? 3_000 : false;
    },
  });
}

export function useCreateWorkspaceSession(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkspaceSessionInput) => createWorkspaceSession(workspaceId!, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.workspaceSessions(workspaceId) });
    },
  });
}

export function useArchiveWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: archiveWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

export function useProvisionWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProvisionWorkspaceInput) => provisionWorkspace(input),
    onSuccess: () => {
      invalidateAfterWorkspaceCreation(queryClient);
    },
  });
}

export function useLinkRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: linkRepository,
    onSuccess: () => {
      invalidateAfterWorkspaceCreation(queryClient);
    },
  });
}

export function useGitHubInstallations(accountId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: workspaceKeys.githubInstallations(accountId),
    queryFn: () => listGitHubInstallations(accountId!),
    enabled: enabled && !!accountId,
    staleTime: 0,
  });
}

export function useGitHubRepositories(
  accountId: string | null,
  installationId: string | null,
  enabled: boolean
) {
  return useQuery({
    queryKey: workspaceKeys.githubRepositories(accountId, installationId),
    queryFn: () => listGitHubRepositories(accountId!, installationId),
    enabled: enabled && !!accountId && !!installationId,
    staleTime: 30_000,
  });
}

// ── Workspace secrets (web parity) ──────────────────────────────────────────────

/** Workspace secrets: shared values + the caller's personal overrides + manifest. */
export function useWorkspaceSecrets(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.secrets(workspaceId),
    queryFn: () => listWorkspaceSecrets(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 15_000,
  });
}

/** Create / update the shared (workspace-wide) value of a secret. */
export function useUpsertWorkspaceSecret(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; value?: string }) =>
      upsertWorkspaceSecret(workspaceId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.secrets(workspaceId) }),
  });
}

/** Delete the shared value of a secret (members' overrides are left intact). */
export function useDeleteWorkspaceSecret(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteWorkspaceSecret(workspaceId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.secrets(workspaceId) }),
  });
}

/** Set the caller's personal override (value and/or active flag). */
export function useSetPersonalWorkspaceSecret(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value, active }: { name: string; value?: string; active?: boolean }) =>
      setPersonalWorkspaceSecret(workspaceId, name, { value, active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.secrets(workspaceId) }),
  });
}

/** Remove the caller's personal override. */
export function useDeletePersonalWorkspaceSecret(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deletePersonalWorkspaceSecret(workspaceId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.secrets(workspaceId) }),
  });
}

// ── Channels — Slack (web parity) ─────────────────────────────────────────────

/** Current Slack install (null when not connected). Polls while pending. */
export function useSlackInstallation(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.slackInstall(workspaceId),
    queryFn: () => getSlackInstallation(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

/** Whether 1-click OAuth is available + the install URL (degrades gracefully). */
export function useSlackMode(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.slackMode(workspaceId),
    queryFn: () =>
      getSlackMode(workspaceId!).catch(() => ({ oauth_available: false, install_url: null })),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

export function useConnectSlack(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { bot_token: string; signing_secret: string }) =>
      connectSlack(workspaceId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.slackInstall(workspaceId) }),
  });
}

export function useDisconnectSlack(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => disconnectSlack(workspaceId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.slackInstall(workspaceId) }),
  });
}

// ── Triggers — schedules (cron) + webhooks (web parity) ───────────────────────

/** All Workspace triggers (cron + webhook). Polls while any are recently active. */
export function useWorkspaceTriggers(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.triggers(workspaceId),
    queryFn: () => listWorkspaceTriggers(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}

export function useCreateWorkspaceTrigger(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkspaceTriggerInput) => createWorkspaceTrigger(workspaceId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.triggers(workspaceId) }),
  });
}

export function useUpdateWorkspaceTrigger(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, input }: { slug: string; input: UpdateWorkspaceTriggerInput }) =>
      updateWorkspaceTrigger(workspaceId, slug, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.triggers(workspaceId) }),
  });
}

export function useDeleteWorkspaceTrigger(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => deleteWorkspaceTrigger(workspaceId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.triggers(workspaceId) }),
  });
}

export function useFireWorkspaceTrigger(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => fireWorkspaceTrigger(workspaceId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.triggers(workspaceId) }),
  });
}

/** Server-side, sandbox-free agent list for a trigger's "Agent" picker — a
 *  workspace may not have a live sandbox running when you're configuring
 *  a trigger, so this reads the repo config directly (web parity:
 *  useVisibleAgents({ workspaceId })). */
export function useWorkspaceAgentsForTrigger(workspaceId: string | null) {
  const { data, isLoading } = useWorkspaceDetail(workspaceId);
  const agents = useMemo(() => filterTriggerAgents(data?.config.agents), [data]);
  return { agents, isLoading };
}

/** Gateway model catalog for a trigger's "Model" override picker (web parity:
 *  useOpenCodeProviders() + flattenModels() in gateway mode). Sandbox-free —
 *  reads the Workspace's server-side catalog directly. `gatewayDisabled` is
 *  true when the Workspace hasn't turned the LLM gateway on; treat that as "no
 *  override available" rather than an error. */
export function useWorkspaceModelCatalogForTrigger(workspaceId: string | null) {
  const query = useQuery({
    queryKey: workspaceKeys.llmCatalog(workspaceId),
    queryFn: () => getWorkspaceLlmCatalog(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 60_000,
    retry: false,
  });
  const gatewayDisabled = (query.error as { code?: string } | null)?.code === 'llm_gateway_disabled';
  const models = useMemo(() => flattenTriggerModelCatalog(query.data?.models), [query.data]);
  return { models, isLoading: query.isLoading, gatewayDisabled };
}

// ── Change requests (web parity) ──────────────────────────────────────────────

/** Invalidate everything that the open-CR count / merge state depends on. */
function invalidateChangeWorld(queryClient: ReturnType<typeof useQueryClient>, workspaceId: string) {
  queryClient.invalidateQueries({ queryKey: ['change-requests', workspaceId] });
  queryClient.invalidateQueries({ queryKey: workspaceKeys.branches(workspaceId) });
  queryClient.invalidateQueries({ queryKey: workspaceKeys.workspaceSessions(workspaceId) });
}

/** CR list, filtered by status. Polls so merged/closed transitions clear live. */
export function useChangeRequests(workspaceId: string | null, status: ChangeRequestStatus | 'all') {
  return useQuery({
    queryKey: workspaceKeys.changeRequests(workspaceId, status),
    queryFn: () => listChangeRequests(workspaceId!, status),
    enabled: !!workspaceId,
    staleTime: 8_000,
    refetchInterval: 8_000,
  });
}

export function useChangeRequest(workspaceId: string | null, crId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.changeRequest(workspaceId, crId),
    queryFn: () => getChangeRequest(workspaceId!, crId!).then((r) => r.change_request),
    enabled: !!workspaceId && !!crId,
    staleTime: 8_000,
    refetchInterval: 8_000,
  });
}

export function useChangeRequestDiff(workspaceId: string | null, crId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.changeRequestDiff(workspaceId, crId),
    queryFn: () => getChangeRequestDiff(workspaceId!, crId!),
    enabled: !!workspaceId && !!crId,
    staleTime: 15_000,
  });
}

/** Merge preview (clean / conflict / up-to-date) — only meaningful for open CRs. */
export function useChangeRequestMergePreview(
  workspaceId: string | null,
  crId: string | null,
  enabled: boolean
) {
  return useQuery({
    queryKey: workspaceKeys.changeRequestMergePreview(workspaceId, crId),
    queryFn: () => getChangeRequestMergePreview(workspaceId!, crId!),
    enabled: enabled && !!workspaceId && !!crId,
    staleTime: 8_000,
  });
}

export function useOpenChangeRequest(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: OpenChangeRequestInput) => openChangeRequest(workspaceId, input),
    onSuccess: () => invalidateChangeWorld(queryClient, workspaceId),
  });
}

export function useMergeChangeRequest(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ crId, message }: { crId: string; message?: string }) =>
      mergeChangeRequest(workspaceId, crId, message),
    onSuccess: (_d, { crId }) => {
      invalidateChangeWorld(queryClient, workspaceId);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.changeRequest(workspaceId, crId) });
    },
  });
}

export function useCloseChangeRequest(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (crId: string) => closeChangeRequest(workspaceId, crId),
    onSuccess: (_d, crId) => {
      invalidateChangeWorld(queryClient, workspaceId);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.changeRequest(workspaceId, crId) });
    },
  });
}

export function useReopenChangeRequest(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (crId: string) => reopenChangeRequest(workspaceId, crId),
    onSuccess: (_d, crId) => {
      invalidateChangeWorld(queryClient, workspaceId);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.changeRequest(workspaceId, crId) });
    },
  });
}

export function usePatchChangeRequest(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      crId,
      title,
      description,
    }: {
      crId: string;
      title?: string;
      description?: string;
    }) => patchChangeRequest(workspaceId, crId, { title, description }),
    onSuccess: (_d, { crId }) => {
      invalidateChangeWorld(queryClient, workspaceId);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.changeRequest(workspaceId, crId) });
    },
  });
}

/** Workspace branches (Versions tab + Open-CR picker). */
export function useWorkspaceBranches(workspaceId: string | null, enabled = true) {
  return useQuery({
    queryKey: workspaceKeys.branches(workspaceId),
    queryFn: () => listWorkspaceBranches(workspaceId!),
    enabled: enabled && !!workspaceId,
    staleTime: 15_000,
  });
}

/** Cheap version-diff preview — gates the Open-CR submit button (no CR created). */
export function useVersionDiff(
  workspaceId: string | null,
  from: string,
  into: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: workspaceKeys.versionDiff(workspaceId, from, into),
    queryFn: () => getVersionDiff(workspaceId!, from, into),
    enabled: enabled && !!workspaceId && !!from && !!into && from !== into,
    staleTime: 10_000,
  });
}

// ── Workspace files (web parity) ────────────────────────────────────────────────

/** Flat, recursive file list for a ref — the browser derives the tree from it. */
export function useWorkspaceFiles(workspaceId: string | null, ref: string) {
  return useQuery({
    queryKey: workspaceKeys.workspaceFiles(workspaceId, ref),
    queryFn: () => listWorkspaceFiles(workspaceId!, { ref }),
    enabled: !!workspaceId && !!ref,
    staleTime: 20_000,
    retry: (count, err: any) => {
      const m = String(err?.message ?? '');
      if (/40[34]/.test(m) || /not found|forbidden/i.test(m)) return false;
      return count < 3;
    },
  });
}

/** Read a file's text content at a ref (version-aware). */
export function useWorkspaceFileContent(workspaceId: string | null, path: string | null, ref: string) {
  return useQuery({
    queryKey: workspaceKeys.workspaceFileContent(workspaceId, path, ref),
    queryFn: () => readWorkspaceFile(workspaceId!, path!, ref),
    enabled: !!workspaceId && !!path && !!ref,
    staleTime: 30_000,
    retry: false,
  });
}

/** Commit history (checkpoints) for a file at a ref. */
export function useWorkspaceFileHistory(workspaceId: string | null, path: string | null, ref: string) {
  return useQuery({
    queryKey: workspaceKeys.workspaceFileHistory(workspaceId, path, ref),
    queryFn: () => getWorkspaceFileHistory(workspaceId!, path!, { ref, limit: 50 }),
    enabled: !!workspaceId && !!path && !!ref,
    staleTime: 30_000,
  });
}

/** The diff a checkpoint (commit) introduced for a file. */
export function useWorkspaceCommitDiff(workspaceId: string | null, sha: string | null, path: string) {
  return useQuery({
    queryKey: workspaceKeys.workspaceCommitDiff(workspaceId, sha, path),
    queryFn: () => getWorkspaceCommitDiff(workspaceId!, sha!, path),
    enabled: !!workspaceId && !!sha && !!path,
    staleTime: 5 * 60_000,
  });
}

// ── Sandbox (web parity) ──────────────────────────────────────────────────────

/** Sandbox templates + recent builds. Polls while anything is building. */
export function useWorkspaceSnapshots(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceKeys.snapshots(workspaceId),
    queryFn: () => listWorkspaceSnapshots(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 10_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const anyBuilding =
        (data.builds ?? []).some((b) => b.status === 'building') ||
        (data.templates ?? []).some((t) =>
          ['pulling', 'building'].includes((t.daytona_state || '').toLowerCase())
        );
      return anyBuilding ? 5_000 : false;
    },
  });
}

export function useCreateSandboxTemplate(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSandboxTemplateInput) => createSandboxTemplate(workspaceId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.snapshots(workspaceId) }),
  });
}

export function useUpdateSandboxTemplate(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      input,
    }: {
      templateId: string;
      input: UpdateSandboxTemplateInput;
    }) => updateSandboxTemplate(workspaceId, templateId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.snapshots(workspaceId) }),
  });
}

export function useBuildSandboxTemplate(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => buildSandboxTemplate(workspaceId, templateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.snapshots(workspaceId) }),
  });
}

export function useDeleteSandboxTemplate(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => deleteSandboxTemplate(workspaceId, templateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.snapshots(workspaceId) }),
  });
}

export function useRebuildSnapshot(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug?: string) => rebuildWorkspaceSnapshot(workspaceId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.snapshots(workspaceId) }),
  });
}

export function useFixSandboxWithAgent(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fixSandboxWithAgent(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.snapshots(workspaceId) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.workspaceSessions(workspaceId) });
    },
  });
}
