/**
 * Projects React Query hooks — web-aligned.
 * Query keys mirror the web app: ['accounts'] and ['projects', accountId].
 */

import { useCallback, useMemo, useRef } from 'react';
import { pickerProviderList, type PickerProviderListInput } from '@kortix/sdk';
import { composerModelList, offeredModelCount } from '@/lib/session/model-picker';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  qk,
  useProjectSessions as useSdkProjectSessions,
  type UseProjectSessionsOptions,
} from '@kortix/sdk/react/session-list';
import { listCreatedSession } from '@/lib/session/session-cache-write';
import { PERSISTED_QUERY_GC_TIME_MS } from '@/lib/query/persisted-queries';
import {
  nextProjectSessionsPollWindow,
  projectSessionsPollInterval,
  type ProjectSessionsPollWindow,
} from './poll-policy';
import {
  archiveProject,
  buildSandboxTemplate,
  closeChangeRequest,
  connectSlack,
  createProjectSession,
  createProjectTrigger,
  createSandboxTemplate,
  deleteConnector,
  deleteSandboxTemplate,
  fixSandboxWithAgent,
  listProjectSnapshots,
  rebuildProjectSnapshot,
  updateSandboxTemplate,
  deletePersonalProjectSecret,
  deleteProjectSecret,
  deleteProjectTrigger,
  disconnectConnector,
  disconnectSlack,
  fireProjectTrigger,
  getChangeRequest,
  getChangeRequestDiff,
  getChangeRequestMergePreview,
  getSlackInstallation,
  getSlackMode,
  getProject,
  getProjectDetail,
  getModelDefaults,
  getProjectLlmCatalog,
  getProjectLlmCatalogProviders,
  getProjectModelPicker,
  getProjectCommitDiff,
  getProjectFileHistory,
  getVersionDiff,
  listAccounts,
  listChangeRequests,
  listConnectors,
  listPipedreamApps,
  listProjectAccess,
  listProjectBranches,
  listProjectFiles,
  listProjectPolicies,
  listProjectSecrets,
  listProjectSessions,
  listProjectTriggers,
  listProjectsForAccount,
  mergeChangeRequest,
  openChangeRequest,
  patchChangeRequest,
  readProjectFile,
  reopenChangeRequest,
  setPersonalProjectSecret,
  setProjectPolicies,
  syncConnectors,
  updateExperimentalFeature,
  updateProject,
  updateProjectTrigger,
  upsertProjectSecret,
  updateProjectDefaultAgent,
  inviteProjectMember,
  updateProjectAccess,
  revokeProjectAccess,
  listPendingProjectInvites,
  resendPendingProjectInvite,
  revokePendingProjectInvite,
  type ChangeRequestStatus,
  type ConnectorSharing,
  type ExperimentalFeatureKey,
  type ProjectRole,
  type CreateProjectSessionInput,
  type CreateProjectTriggerInput,
  type CreateSandboxTemplateInput,
  type OpenChangeRequestInput,
  type PolicyDefaultMode,
  type ProjectPolicy,
  type ProjectSession,
  type UpdateProjectTriggerInput,
  type UpdateSandboxTemplateInput,
} from './projects-client';
import { filterTriggerAgents, flattenTriggerModelCatalog } from './trigger-picker-options';
import { useOpenCodeProviders } from '@/lib/opencode/hooks/use-opencode-data';

export type { TriggerAgentOption, TriggerModelOption } from './trigger-picker-options';

export const projectKeys = {
  accounts: ['accounts'] as const,
  projects: (accountId: string | null | undefined) => ['projects', accountId] as const,
  project: (projectId: string | null | undefined) => ['project', projectId] as const,
  projectDetail: (projectId: string | null | undefined) => ['project-detail', projectId] as const,
  llmCatalog: (projectId: string | null | undefined) => ['project-llm-catalog', projectId] as const,
  modelPicker: (projectId: string | null | undefined) => ['project-model-picker', projectId] as const,
  /** Native-mode picker sources: `/llm-catalog/providers` + secret names (`useComposerModels`). */
  nativeModelCatalog: (projectId: string | null | undefined) => ['project-model-catalog-native', projectId] as const,
  modelDefaults: (projectId: string | null | undefined) => ['model-defaults', projectId] as const,
  projectFile: (projectId: string | null | undefined, path: string | null | undefined) =>
    ['project-file', projectId, path] as const,
  /** A session's public shares (KRTX-248: the transcript link). */
  sessionPublicShares: (projectId: string | null | undefined, sessionId: string | null | undefined) =>
    ['session-public-shares', projectId, sessionId] as const,
  connectors: (projectId: string | null | undefined) => ['project-connectors', projectId] as const,
  secrets: (projectId: string | null | undefined) => ['project-secrets', projectId] as const,
  slackInstall: (projectId: string | null | undefined) => ['slack-install', projectId] as const,
  slackMode: (projectId: string | null | undefined) => ['slack-mode', projectId] as const,
  triggers: (projectId: string | null | undefined) => ['project-triggers', projectId] as const,
  changeRequests: (projectId: string | null | undefined, status: string) =>
    ['change-requests', projectId, status] as const,
  changeRequest: (projectId: string | null | undefined, crId: string | null | undefined) =>
    ['change-request', projectId, crId] as const,
  changeRequestDiff: (projectId: string | null | undefined, crId: string | null | undefined) =>
    ['change-request-diff', projectId, crId] as const,
  changeRequestMergePreview: (
    projectId: string | null | undefined,
    crId: string | null | undefined
  ) => ['change-request-merge-preview', projectId, crId] as const,
  branches: (projectId: string | null | undefined) => ['project-branches', projectId] as const,
  projectFiles: (projectId: string | null | undefined, ref: string) =>
    ['project-files', projectId, ref] as const,
  projectFileContent: (
    projectId: string | null | undefined,
    path: string | null | undefined,
    ref: string
  ) => ['project-file-content', projectId, path, ref] as const,
  projectFileHistory: (
    projectId: string | null | undefined,
    path: string | null | undefined,
    ref: string
  ) => ['project-file-history', projectId, path, ref] as const,
  projectCommitDiff: (
    projectId: string | null | undefined,
    sha: string | null | undefined,
    path: string
  ) => ['project-commit-diff', projectId, sha, path] as const,
  snapshots: (projectId: string | null | undefined) => ['project-snapshots', projectId] as const,
  versionDiff: (projectId: string | null | undefined, from: string, into: string) =>
    ['version-diff', projectId, from, into] as const,
  projectAccess: (projectId: string | null | undefined) => ['project-access', projectId] as const,
  pendingInvites: (projectId: string | null | undefined) =>
    ['project-pending-invites', projectId] as const,
  policies: (projectId: string | null | undefined) => ['project-policies', projectId] as const,
  pipedreamApps: (projectId: string | null | undefined, q: string) =>
    ['pipedream-apps', projectId, q] as const,
  pipedreamAppMeta: (projectId: string | null | undefined, slug: string | null | undefined) =>
    ['pipedream-app-meta', projectId, slug] as const,
};

export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: projectKeys.accounts,
    queryFn: listAccounts,
    enabled,
    staleTime: 60_000,
  });
}

export function useProjects(accountId: string | null) {
  return useQuery({
    queryKey: projectKeys.projects(accountId),
    queryFn: () => listProjectsForAccount(accountId || undefined),
    enabled: !!accountId,
    staleTime: 20_000,
  });
}

export function useProject(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.project(projectId),
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
    staleTime: 20_000,
  });
}

// ── Settings (web parity: customize/sections/settings-view) ───────────────────

/** Patch project fields (name / default branch / manifest path). */
export function useUpdateProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; default_branch?: string; manifest_path?: string }) =>
      updateProject(projectId, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(projectKeys.project(projectId), updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** Toggle an experimental / WIP feature for this project. */
export function useUpdateExperimentalFeature(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      feature,
      enabled,
    }: {
      feature: ExperimentalFeatureKey;
      enabled: boolean | null;
    }) => updateExperimentalFeature(projectId, feature, enabled),
    onSuccess: (updated) => {
      queryClient.setQueryData(projectKeys.project(projectId), updated);
      queryClient.invalidateQueries({ queryKey: projectKeys.projectDetail(projectId) });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** Project config summary — agents, skills, commands (web parity). */
export function useProjectDetail(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.projectDetail(projectId),
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

/** Read a repo file's content (config source views). */
export function useProjectFile(projectId: string | null, path: string | null) {
  return useQuery({
    queryKey: projectKeys.projectFile(projectId, path),
    queryFn: () => readProjectFile(projectId!, path!),
    enabled: !!projectId && !!path,
    staleTime: 30_000,
  });
}

// ── Connectors (web parity) ──────────────────────────────────────────────────

/** Connected tool connectors for a project. */
export function useConnectors(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.connectors(projectId),
    queryFn: () => listConnectors(projectId!),
    enabled: !!projectId,
    staleTime: 15_000,
  });
}

/** Re-index connector actions from their providers. */
export function useSyncConnectors(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncConnectors(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) }),
  });
}

/** Remove a connector. */
export function useDeleteConnector(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => deleteConnector(projectId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) }),
  });
}

/** Disconnect a connector — remove its credential but keep the connector. */
export function useDisconnectConnector(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => disconnectConnector(projectId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) }),
  });
}

/** Tool-approval policies for a project. */
export function useProjectPolicies(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.policies(projectId),
    queryFn: () => listProjectPolicies(projectId!),
    enabled: !!projectId,
    staleTime: 15_000,
  });
}

export function useSetProjectPolicies(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      policies,
      defaultMode,
    }: {
      policies: ProjectPolicy[];
      defaultMode: PolicyDefaultMode;
    }) => setProjectPolicies(projectId, policies, defaultMode),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.policies(projectId) }),
  });
}

/** Project members (for the Members page). */
export function useProjectAccess(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.projectAccess(projectId),
    queryFn: () => listProjectAccess(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

// ── Members (web parity: customize/sections/members-view) ─────────────────────

export function usePendingProjectInvites(projectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: projectKeys.pendingInvites(projectId),
    queryFn: () => listPendingProjectInvites(projectId!),
    enabled: enabled && !!projectId,
    staleTime: 5_000,
  });
}

/** Invalidate everything that a membership change can ripple into. */
function useInvalidateMembership(projectId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: projectKeys.projectAccess(projectId) });
    queryClient.invalidateQueries({ queryKey: projectKeys.project(projectId) });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
}

export function useInviteProjectMember(projectId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateMembership(projectId);
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: ProjectRole }) =>
      inviteProjectMember(projectId, email, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.pendingInvites(projectId) });
      invalidate();
    },
  });
}

export function useUpdateProjectAccess(projectId: string) {
  const invalidate = useInvalidateMembership(projectId);
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
      updateProjectAccess(projectId, userId, role),
    onSuccess: invalidate,
  });
}

export function useRevokeProjectAccess(projectId: string) {
  const invalidate = useInvalidateMembership(projectId);
  return useMutation({
    mutationFn: (userId: string) => revokeProjectAccess(projectId, userId),
    onSuccess: invalidate,
  });
}

export function useResendProjectInvite(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => resendPendingProjectInvite(projectId, inviteId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: projectKeys.pendingInvites(projectId) }),
  });
}

export function useRevokeProjectInvite(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => revokePendingProjectInvite(projectId, inviteId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: projectKeys.pendingInvites(projectId) }),
  });
}

/** Resolve a single Pipedream app's display name + logo by its slug, for showing
 *  connected connectors with their real app branding. Cached; lazy per row. */
export function usePipedreamAppMeta(projectId: string | null, slug: string | null, enabled = true) {
  return useQuery({
    queryKey: projectKeys.pipedreamAppMeta(projectId, slug),
    queryFn: async () => {
      const page = await listPipedreamApps(projectId!, slug || undefined);
      return page.apps.find((a) => a.slug === slug) ?? page.apps[0] ?? null;
    },
    enabled: enabled && !!projectId && !!slug,
    staleTime: 5 * 60_000,
  });
}

/** Searchable, paginated Pipedream app catalogue (Easy Connect). */
export function usePipedreamApps(projectId: string | null, q: string) {
  return useInfiniteQuery({
    queryKey: projectKeys.pipedreamApps(projectId, q),
    queryFn: ({ pageParam }) => listPipedreamApps(projectId!, q || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

/** Background-poll options for list hooks. */
export interface PollOptions {
  /** Run the interval poll. `false` pauses it, e.g. while the screen is not focused. Default `true`. */
  poll?: boolean;
}

/**
 * The provisioning poll (lib/projects/poll-policy) as a `refetchInterval`
 * over the rows loaded so far: 3 s while a row is still coming up, for at most
 * 4 min per set of pending rows. One window per hook instance.
 */
function useProvisioningPoll(poll: boolean) {
  const pollWindowRef = useRef<ProjectSessionsPollWindow | null>(null);
  return (rows: readonly ProjectSession[] | undefined): number | false => {
    const now = Date.now();
    const pollWindow = nextProjectSessionsPollWindow(pollWindowRef.current, rows, now);
    pollWindowRef.current = pollWindow;
    if (!poll || !pollWindow) return false;
    return projectSessionsPollInterval(rows, pollWindow.startedAt, now);
  };
}

/** Page one of the project's sessions as a flat array: lookups (the thread's
 *  title, sub-agents), not browsing. Cached at the SDK's flat key
 *  (`qk.project.sessions`), so the SDK's cache writers reach it. */
export function useProjectSessions(projectId: string | null, { poll = true }: PollOptions = {}) {
  const pollInterval = useProvisioningPoll(poll);
  return useQuery({
    queryKey: qk.project.sessions(projectId ?? ''),
    queryFn: () => listProjectSessions(projectId!),
    enabled: !!projectId,
    staleTime: 10_000,
    refetchInterval: (query) => pollInterval(query.state.data),
  });
}

/**
 * A project's sessions a page at a time, newest activity first — the list the
 * project drawer and the Sessions page scroll: the SDK's `useProjectSessions`
 * with this app's provisioning poll. A new search or scope keeps the previous
 * rows on screen until its answer lands.
 */
export function useProjectSessionsPaged(
  projectId: string | null,
  {
    poll = true,
    enabled = true,
    ...options
  }: PollOptions & Pick<UseProjectSessionsOptions, 'parent' | 'startedBy' | 'q' | 'limit' | 'enabled'> = {}
) {
  const pollInterval = useProvisioningPoll(poll);
  return useSdkProjectSessions(projectId ?? '', {
    ...options,
    enabled: !!projectId && enabled,
    keepPreviousData: true,
    refetchInterval: pollInterval,
    // The SDK's inventory contract would drop an unviewed list after 30 min,
    // and with it the copy restored on the next launch.
    gcTime: PERSISTED_QUERY_GC_TIME_MS,
  });
}

export function useCreateProjectSession(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectSessionInput) => createProjectSession(projectId!, input),
    onSuccess: (created) => {
      // The drawer and the Sessions page list it the moment the POST answers;
      // the refetch below then replaces it with the list's own row.
      if (!projectId) return;
      listCreatedSession(queryClient, projectId, created);
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
  });
}

export function useArchiveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: archiveProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ── Project secrets (web parity) ──────────────────────────────────────────────

/** Project secrets: shared values + the caller's personal overrides + manifest. */
export function useProjectSecrets(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId!),
    enabled: !!projectId,
    staleTime: 15_000,
  });
}

/** Create / update the shared (project-wide) value of a secret. */
export function useUpsertProjectSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; value?: string; sharing?: ConnectorSharing }) =>
      upsertProjectSecret(projectId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.secrets(projectId) }),
  });
}

/** Set the agent a new session runs on when the user picks none. */
export function useSetProjectDefaultAgent(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentName: string) => updateProjectDefaultAgent(projectId, agentName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.projectDetail(projectId) }),
  });
}

/** Delete the shared value of a secret (members' overrides are left intact). */
export function useDeleteProjectSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteProjectSecret(projectId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.secrets(projectId) }),
  });
}

/** Set the caller's personal override (value and/or active flag). */
export function useSetPersonalProjectSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value, active }: { name: string; value?: string; active?: boolean }) =>
      setPersonalProjectSecret(projectId, name, { value, active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.secrets(projectId) }),
  });
}

/** Remove the caller's personal override. */
export function useDeletePersonalProjectSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deletePersonalProjectSecret(projectId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.secrets(projectId) }),
  });
}

// ── Channels — Slack (web parity) ─────────────────────────────────────────────

/** Current Slack install (null when not connected). Polls while pending. */
export function useSlackInstallation(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.slackInstall(projectId),
    queryFn: () => getSlackInstallation(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

/** Whether 1-click OAuth is available + the install URL (degrades gracefully). */
export function useSlackMode(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.slackMode(projectId),
    queryFn: () =>
      getSlackMode(projectId!).catch(() => ({ oauth_available: false, install_url: null })),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

export function useConnectSlack(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { bot_token: string; signing_secret: string }) =>
      connectSlack(projectId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: projectKeys.slackInstall(projectId) }),
  });
}

export function useDisconnectSlack(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => disconnectSlack(projectId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: projectKeys.slackInstall(projectId) }),
  });
}

// ── Triggers — schedules (cron) + webhooks (web parity) ───────────────────────

/** All project triggers (cron + webhook). Polls while any are recently active. */
export function useProjectTriggers(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.triggers(projectId),
    queryFn: () => listProjectTriggers(projectId!),
    enabled: !!projectId,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}

export function useCreateProjectTrigger(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectTriggerInput) => createProjectTrigger(projectId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.triggers(projectId) }),
  });
}

export function useUpdateProjectTrigger(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, input }: { slug: string; input: UpdateProjectTriggerInput }) =>
      updateProjectTrigger(projectId, slug, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.triggers(projectId) }),
  });
}

export function useDeleteProjectTrigger(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => deleteProjectTrigger(projectId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.triggers(projectId) }),
  });
}

export function useFireProjectTrigger(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => fireProjectTrigger(projectId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.triggers(projectId) }),
  });
}

/** Server-side, sandbox-free agent list for a trigger's "Agent" picker — a
 *  project may not have a live sandbox running when you're just configuring
 *  a trigger, so this reads the repo config directly (web parity:
 *  useVisibleAgents({ projectId })). */
export function useProjectAgentsForTrigger(projectId: string | null) {
  const { data, isLoading } = useProjectDetail(projectId);
  const agents = useMemo(() => filterTriggerAgents(data?.config.agents), [data]);
  return { agents, isLoading };
}

/** Gateway model catalog for a trigger's "Model" override picker (web parity:
 *  useOpenCodeProviders() + flattenModels() in gateway mode). Sandbox-free —
 *  reads the project's server-side catalog directly. `gatewayDisabled` is
 *  true when the project hasn't turned the LLM gateway on; treat that as "no
 *  override available" rather than an error. */
export function useProjectModelCatalogForTrigger(projectId: string | null) {
  // `/model-picker`, NOT `/llm-catalog`: the raw catalog is the full runtime
  // projection (7134 models on 2026-09-16). The picker rendered every one of
  // them as a row, so the sheet froze when it opened (Jay, 2026-09-22). The
  // model picker is the bounded, connection-aware list the composer reads, and
  // it shares that query's cache: the list is usually there before the tap.
  const query = useQuery({
    queryKey: projectKeys.modelPicker(projectId),
    queryFn: () => getProjectModelPicker(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
  });
  const gatewayDisabled = (query.error as { code?: string } | null)?.code === 'llm_gateway_disabled';
  const models = useMemo(() => flattenTriggerModelCatalog(query.data?.models), [query.data]);
  return { models, isLoading: query.isLoading, gatewayDisabled };
}

/** The native-mode picker sources that need no sandbox: the runtime catalog
 *  and the project's secret NAMES. `project.secret.read` is manager-tier, so a
 *  member's read 403s: that is "no keys visible" (web: `useOpenCodeProviders`). */
async function fetchNativeModelCatalog(projectId: string) {
  const [llmCatalogProviders, secrets] = await Promise.all([
    getProjectLlmCatalogProviders(projectId),
    listProjectSecrets(projectId).catch(() => ({ items: [] as Array<{ name: string }> })),
  ]);
  return { llmCatalogProviders, secretNames: secrets.items.map((secret) => secret.name) };
}

/**
 * The composer's models (project home and thread), from the sources web's
 * `useRuntimeProviders` and `useModelDefaults` read, built by `@kortix/sdk`
 * (`pickerProviderList` → `flattenModels`):
 * - LLM gateway on (`/detail` `experimental.llm_gateway`): `/model-picker`;
 * - gateway off: `/llm-catalog/providers` and the project's secret names,
 *   merged with the thread sandbox's `/provider` list once it answers.
 * `modelDefaults` (`/model-defaults`) exists only with the gateway on; the
 * route answers 404 `llm_gateway_disabled` otherwise.
 * `isLoading`: the project mode, the list, or the default is not known yet.
 * Consumers hide the chip instead of flashing a wrong list.
 */
export function useComposerModels(projectId: string | null, sandboxUrl?: string) {
  const detail = useProjectDetail(projectId);
  const modeKnown = !projectId || detail.isSuccess;
  const gatewayEnabled = detail.data?.project?.experimental?.llm_gateway === true;
  const gatewayQuery = !!projectId && modeKnown && gatewayEnabled;
  const nativeQuery = !!projectId && modeKnown && !gatewayEnabled;

  const picker = useQuery({
    queryKey: projectKeys.modelPicker(projectId),
    queryFn: () => getProjectModelPicker(projectId!),
    enabled: gatewayQuery,
    staleTime: 60_000,
    retry: false,
  });
  const nativeCatalog = useQuery({
    queryKey: projectKeys.nativeModelCatalog(projectId),
    queryFn: () => fetchNativeModelCatalog(projectId!),
    enabled: nativeQuery,
    staleTime: 60_000,
    retry: false,
  });
  const runtime = useOpenCodeProviders(modeKnown && !gatewayEnabled ? sandboxUrl : undefined);
  const defaults = useQuery({
    queryKey: projectKeys.modelDefaults(projectId),
    queryFn: () => getModelDefaults(projectId!),
    enabled: gatewayQuery,
    staleTime: 30_000,
    retry: false,
  });

  const nativeData = nativeCatalog.data;
  const sources = useMemo<PickerProviderListInput>(
    () => ({
      gatewayEnabled,
      modelPicker: picker.data,
      llmCatalogProviders: nativeData?.llmCatalogProviders,
      secretNames: new Set(nativeData?.secretNames ?? []),
      runtimeProviders: runtime.data,
    }),
    [gatewayEnabled, picker.data, nativeData, runtime.data],
  );
  const providers = useMemo(() => pickerProviderList(sources), [sources]);
  const models = useMemo(() => composerModelList(sources), [sources]);

  // `ConnectProviderSheet` refetches once the in-app browser closes, to toast
  // "Provider connected" only once the list actually turns up a model.
  const refetchModelCount = useCallback(async () => {
    if (gatewayEnabled) {
      const result = await picker.refetch();
      return offeredModelCount(composerModelList({ ...sources, modelPicker: result.data }));
    }
    const result = await nativeCatalog.refetch();
    return offeredModelCount(
      composerModelList({
        ...sources,
        llmCatalogProviders: result.data?.llmCatalogProviders,
        secretNames: new Set(result.data?.secretNames ?? []),
      }),
    );
  }, [gatewayEnabled, picker, nativeCatalog, sources]);

  const isLoading =
    (!!projectId && detail.isPending) ||
    (gatewayEnabled
      ? picker.isLoading || defaults.isLoading
      : !providers && (nativeCatalog.isLoading || runtime.isLoading));

  return {
    gatewayEnabled,
    providers,
    /** Every model the picker can list (`enabled: false` rows included, as web). */
    models,
    modelDefaults: defaults.data,
    isLoading,
    refetchModelCount,
  };
}

// ── Change requests (web parity) ──────────────────────────────────────────────

/** Invalidate everything that the open-CR count / merge state depends on. */
function invalidateChangeWorld(queryClient: ReturnType<typeof useQueryClient>, projectId: string) {
  queryClient.invalidateQueries({ queryKey: ['change-requests', projectId] });
  queryClient.invalidateQueries({ queryKey: projectKeys.branches(projectId) });
  queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
}

/** CR list, filtered by status. Polls so merged/closed transitions clear live. */
export function useChangeRequests(
  projectId: string | null,
  status: ChangeRequestStatus | 'all',
  { poll = true }: PollOptions = {}
) {
  return useQuery({
    queryKey: projectKeys.changeRequests(projectId, status),
    queryFn: () => listChangeRequests(projectId!, status),
    enabled: !!projectId,
    staleTime: 8_000,
    refetchInterval: poll ? 8_000 : false,
  });
}

export function useChangeRequest(projectId: string | null, crId: string | null) {
  return useQuery({
    queryKey: projectKeys.changeRequest(projectId, crId),
    queryFn: () => getChangeRequest(projectId!, crId!).then((r) => r.change_request),
    enabled: !!projectId && !!crId,
    staleTime: 8_000,
    refetchInterval: 8_000,
  });
}

export function useChangeRequestDiff(projectId: string | null, crId: string | null) {
  return useQuery({
    queryKey: projectKeys.changeRequestDiff(projectId, crId),
    queryFn: () => getChangeRequestDiff(projectId!, crId!),
    enabled: !!projectId && !!crId,
    staleTime: 15_000,
  });
}

/** Merge preview (clean / conflict / up-to-date) — only meaningful for open CRs. */
export function useChangeRequestMergePreview(
  projectId: string | null,
  crId: string | null,
  enabled: boolean
) {
  return useQuery({
    queryKey: projectKeys.changeRequestMergePreview(projectId, crId),
    queryFn: () => getChangeRequestMergePreview(projectId!, crId!),
    enabled: enabled && !!projectId && !!crId,
    staleTime: 8_000,
  });
}

export function useOpenChangeRequest(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: OpenChangeRequestInput) => openChangeRequest(projectId, input),
    onSuccess: () => invalidateChangeWorld(queryClient, projectId),
  });
}

export function useMergeChangeRequest(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ crId, message }: { crId: string; message?: string }) =>
      mergeChangeRequest(projectId, crId, message),
    onSuccess: (_d, { crId }) => {
      invalidateChangeWorld(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: projectKeys.changeRequest(projectId, crId) });
    },
  });
}

export function useCloseChangeRequest(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (crId: string) => closeChangeRequest(projectId, crId),
    onSuccess: (_d, crId) => {
      invalidateChangeWorld(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: projectKeys.changeRequest(projectId, crId) });
    },
  });
}

export function useReopenChangeRequest(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (crId: string) => reopenChangeRequest(projectId, crId),
    onSuccess: (_d, crId) => {
      invalidateChangeWorld(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: projectKeys.changeRequest(projectId, crId) });
    },
  });
}

export function usePatchChangeRequest(projectId: string) {
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
    }) => patchChangeRequest(projectId, crId, { title, description }),
    onSuccess: (_d, { crId }) => {
      invalidateChangeWorld(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: projectKeys.changeRequest(projectId, crId) });
    },
  });
}

/** Project branches (Versions tab + Open-CR picker). */
export function useProjectBranches(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: projectKeys.branches(projectId),
    queryFn: () => listProjectBranches(projectId!),
    enabled: enabled && !!projectId,
    staleTime: 15_000,
  });
}

/** Cheap version-diff preview — gates the Open-CR submit button (no CR created). */
export function useVersionDiff(
  projectId: string | null,
  from: string,
  into: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: projectKeys.versionDiff(projectId, from, into),
    queryFn: () => getVersionDiff(projectId!, from, into),
    enabled: enabled && !!projectId && !!from && !!into && from !== into,
    staleTime: 10_000,
  });
}

// ── Project files (web parity) ────────────────────────────────────────────────

/** Flat, recursive file list for a ref — the browser derives the tree from it. */
export function useProjectFiles(projectId: string | null, ref: string) {
  return useQuery({
    queryKey: projectKeys.projectFiles(projectId, ref),
    queryFn: () => listProjectFiles(projectId!, { ref }),
    enabled: !!projectId && !!ref,
    staleTime: 20_000,
    retry: (count, err: any) => {
      const m = String(err?.message ?? '');
      if (/40[34]/.test(m) || /not found|forbidden/i.test(m)) return false;
      return count < 3;
    },
  });
}

/** Read a file's text content at a ref (version-aware). */
export function useProjectFileContent(projectId: string | null, path: string | null, ref: string) {
  return useQuery({
    queryKey: projectKeys.projectFileContent(projectId, path, ref),
    queryFn: () => readProjectFile(projectId!, path!, ref),
    enabled: !!projectId && !!path && !!ref,
    staleTime: 30_000,
    retry: false,
  });
}

/** Commit history (checkpoints) for a file at a ref. */
export function useProjectFileHistory(projectId: string | null, path: string | null, ref: string) {
  return useQuery({
    queryKey: projectKeys.projectFileHistory(projectId, path, ref),
    queryFn: () => getProjectFileHistory(projectId!, path!, { ref, limit: 50 }),
    enabled: !!projectId && !!path && !!ref,
    staleTime: 30_000,
  });
}

/** The diff a checkpoint (commit) introduced for a file. */
export function useProjectCommitDiff(projectId: string | null, sha: string | null, path: string) {
  return useQuery({
    queryKey: projectKeys.projectCommitDiff(projectId, sha, path),
    queryFn: () => getProjectCommitDiff(projectId!, sha!, path),
    enabled: !!projectId && !!sha && !!path,
    staleTime: 5 * 60_000,
  });
}

// ── Sandbox (web parity) ──────────────────────────────────────────────────────

/** Sandbox templates + recent builds. Polls while anything is building. */
export function useProjectSnapshots(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.snapshots(projectId),
    queryFn: () => listProjectSnapshots(projectId!),
    enabled: !!projectId,
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

export function useCreateSandboxTemplate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSandboxTemplateInput) => createSandboxTemplate(projectId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.snapshots(projectId) }),
  });
}

export function useUpdateSandboxTemplate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      input,
    }: {
      templateId: string;
      input: UpdateSandboxTemplateInput;
    }) => updateSandboxTemplate(projectId, templateId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.snapshots(projectId) }),
  });
}

export function useBuildSandboxTemplate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => buildSandboxTemplate(projectId, templateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.snapshots(projectId) }),
  });
}

export function useDeleteSandboxTemplate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => deleteSandboxTemplate(projectId, templateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.snapshots(projectId) }),
  });
}

export function useRebuildSnapshot(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug?: string) => rebuildProjectSnapshot(projectId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.snapshots(projectId) }),
  });
}

export function useFixSandboxWithAgent(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fixSandboxWithAgent(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.snapshots(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
  });
}
