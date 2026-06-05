/**
 * Projects React Query hooks — web-aligned.
 * Query keys mirror the web app: ['accounts'] and ['projects', accountId].
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveProject,
  createAccount,
  createProjectSession,
  deleteConnector,
  getProject,
  getProjectDetail,
  linkRepository,
  listAccounts,
  listConnectors,
  listGitHubInstallations,
  listGitHubRepositories,
  listPipedreamApps,
  listProjectAccess,
  listProjectSessions,
  listProjectsForAccount,
  provisionProject,
  readProjectFile,
  setConnectorSharing,
  syncConnectors,
  type ConnectorSharing,
  type CreateProjectSessionInput,
} from './projects-client';

export const projectKeys = {
  accounts: ['accounts'] as const,
  projects: (accountId: string | null | undefined) => ['projects', accountId] as const,
  project: (projectId: string | null | undefined) => ['project', projectId] as const,
  projectDetail: (projectId: string | null | undefined) => ['project-detail', projectId] as const,
  projectFile: (projectId: string | null | undefined, path: string | null | undefined) =>
    ['project-file', projectId, path] as const,
  projectSessions: (projectId: string | null | undefined) => ['project-sessions', projectId] as const,
  connectors: (projectId: string | null | undefined) => ['project-connectors', projectId] as const,
  projectAccess: (projectId: string | null | undefined) => ['project-access', projectId] as const,
  pipedreamApps: (projectId: string | null | undefined, q: string) =>
    ['pipedream-apps', projectId, q] as const,
  githubInstallations: (accountId: string | null | undefined) =>
    ['github-installations', accountId] as const,
  githubRepositories: (accountId: string | null | undefined, installationId: string | null | undefined) =>
    ['github-repositories', accountId, installationId] as const,
};

export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: projectKeys.accounts,
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

/** Change who can use a connector (project / private / members). */
export function useSetConnectorSharing(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, intent }: { slug: string; intent: ConnectorSharing }) =>
      setConnectorSharing(projectId, slug, intent),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) }),
  });
}

/** Project members (for the connector sharing member picker). */
export function useProjectAccess(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.projectAccess(projectId),
    queryFn: () => listProjectAccess(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
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

export function useProjectSessions(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.projectSessions(projectId),
    queryFn: () => listProjectSessions(projectId!),
    enabled: !!projectId,
    staleTime: 10_000,
    // Poll so freshly-provisioning session sandboxes flip to running in the list.
    refetchInterval: (query) => {
      const data = query.state.data;
      const pending = data?.some((s) =>
        ['queued', 'branching', 'provisioning'].includes(s.status),
      );
      return pending ? 3_000 : false;
    },
  });
}

export function useCreateProjectSession(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectSessionInput) => createProjectSession(projectId!, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
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

export function useProvisionProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: provisionProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useLinkRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: linkRepository,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useGitHubInstallations(accountId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: projectKeys.githubInstallations(accountId),
    queryFn: () => listGitHubInstallations(accountId!),
    enabled: enabled && !!accountId,
    staleTime: 0,
  });
}

export function useGitHubRepositories(
  accountId: string | null,
  installationId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: projectKeys.githubRepositories(accountId, installationId),
    queryFn: () => listGitHubRepositories(accountId!, installationId),
    enabled: enabled && !!accountId && !!installationId,
    staleTime: 30_000,
  });
}
