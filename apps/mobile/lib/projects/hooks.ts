/**
 * Projects React Query hooks — web-aligned.
 * Query keys mirror the web app: ['accounts'] and ['projects', accountId].
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveProject,
  createAccount,
  createProjectSession,
  getProject,
  linkRepository,
  listAccounts,
  listGitHubInstallations,
  listGitHubRepositories,
  listProjectSessions,
  listProjectsForAccount,
  provisionProject,
  type CreateProjectSessionInput,
} from './projects-client';

export const projectKeys = {
  accounts: ['accounts'] as const,
  projects: (accountId: string | null | undefined) => ['projects', accountId] as const,
  project: (projectId: string | null | undefined) => ['project', projectId] as const,
  projectSessions: (projectId: string | null | undefined) => ['project-sessions', projectId] as const,
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
