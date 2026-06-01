/**
 * Projects React Query hooks — web-aligned.
 * Query keys mirror the web app: ['accounts'] and ['projects', accountId].
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveProject,
  linkRepository,
  listAccounts,
  listGitHubInstallations,
  listGitHubRepositories,
  listProjectsForAccount,
  provisionProject,
} from './projects-client';

export const projectKeys = {
  accounts: ['accounts'] as const,
  projects: (accountId: string | null | undefined) => ['projects', accountId] as const,
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

export function useProjects(accountId: string | null) {
  return useQuery({
    queryKey: projectKeys.projects(accountId),
    queryFn: () => listProjectsForAccount(accountId || undefined),
    enabled: !!accountId,
    staleTime: 20_000,
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
