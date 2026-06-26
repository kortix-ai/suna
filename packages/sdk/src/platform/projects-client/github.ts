// GitHub — repository linking and GitHub App installation management.

import { backendApi } from '../api-client';
import { unwrap, type ProjectGitConnection } from './shared';
import type { KortixProject } from './projects';

export interface GitHubRepository {
  id: string;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  description: string | null;
}

export interface GitHubRepositoriesResponse {
  account_id: string;
  installation_id: string;
  owner_login: string;
  repositories: GitHubRepository[];
}

export interface LinkRepositoryInput {
  account_id?: string;
  repo_url?: string;
  repo_full_name?: string;
  installation_id?: string;
  name?: string;
  default_branch?: string;
  manifest_path?: string;
}

export interface LinkRepositoryResponse {
  project: KortixProject;
  git_connection: ProjectGitConnection | null;
}

export interface GitHubInstallationStatus {
  account_id: string;
  installation_row_id: string | null;
  installed: boolean;
  configured: boolean;
  requires_installation: boolean;
  install_url: string | null;
  installation_id: string | null;
  owner_login: string | null;
  owner_type: string | null;
  repository_selection: string | null;
  permissions: Record<string, unknown>;
  installation_url: string | null;
  updated_at: string | null;
}

export interface GitHubInstallationsResponse extends GitHubInstallationStatus {
  installations: GitHubInstallationStatus[];
}

export async function linkRepository(input: LinkRepositoryInput) {
  return unwrap(
    await backendApi.post<LinkRepositoryResponse>(
      '/projects/link-repository',
      input,
      {
        showErrors: false,
      },
    ),
  );
}

export async function getGitHubInstallation(accountId: string) {
  return unwrap(
    await backendApi.get<GitHubInstallationsResponse>(
      `/projects/github/installation?account_id=${encodeURIComponent(accountId)}`,
      { showErrors: false },
    ),
  );
}

export async function listGitHubInstallations(accountId: string) {
  return unwrap(
    await backendApi.get<GitHubInstallationsResponse>(
      `/projects/github/installations?account_id=${encodeURIComponent(accountId)}`,
      { showErrors: false },
    ),
  );
}

export async function listGitHubRepositories(
  accountId: string,
  installationId?: string | null,
) {
  const params = new URLSearchParams({ account_id: accountId });
  if (installationId) params.set('installation_id', installationId);
  return unwrap(
    await backendApi.get<GitHubRepositoriesResponse>(
      `/projects/github/repositories?${params.toString()}`,
      { showErrors: false },
    ),
  );
}

export async function saveGitHubInstallation(input: {
  state: string;
  installation_id: string;
}) {
  return unwrap(
    await backendApi.post<GitHubInstallationStatus>(
      '/projects/github/installation',
      input,
      { showErrors: false },
    ),
  );
}

export async function deleteGitHubInstallation(
  accountId: string,
  installationId?: string | null,
) {
  const params = new URLSearchParams({ account_id: accountId });
  if (installationId) params.set('installation_id', installationId);
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/github/installation?${params.toString()}`,
    ),
  );
}
