// GitHub — repository linking and GitHub App installation management.

import { backendApi } from '../../http/api-client';
import type { KortixProject } from './projects';
import { type ProjectGitConnection, unwrap } from './shared';

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

export interface GitHubRepositoryBranch {
  name: string;
  protected: boolean;
}

export interface GitHubRepositoryBranchesResponse {
  account_id: string;
  installation_id: string;
  owner_login: string;
  repo_full_name: string;
  default_branch: string;
  branches: GitHubRepositoryBranch[];
}

export interface LinkRepositoryInput {
  account_id?: string;
  repo_url?: string;
  repo_full_name?: string;
  installation_id?: string;
  repository_id?: string;
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
  connection_id?: string | null;
  connection_provider?: 'nango' | 'github_app' | null;
  connection_status?: 'connected' | 'needs_reconnect' | 'error' | 'disconnected' | null;
  reconnect_required?: boolean;
}

export interface GitHubInstallationsResponse extends GitHubInstallationStatus {
  installations: GitHubInstallationStatus[];
}

export interface LinkableGitHubInstallation {
  installation_id: string;
  owner_login: string | null;
  owner_type: string | null;
  repository_selection: string | null;
  permissions: Record<string, unknown>;
  installation_url: string | null;
  linked: boolean;
}

export interface LinkableGitHubInstallationsResponse {
  account_id: string;
  github_login: string;
  configured: boolean;
  install_url: string | null;
  installations: LinkableGitHubInstallation[];
}

export interface GitHubConnectionInput {
  accountId: string;
  installationId: string;
}

export interface GitHubConnectSessionInput {
  accountId: string;
}

export interface GitHubConnectSessionResponse {
  token: string;
  expires_at: string;
  connect_link: string;
}

export type GitHubDisconnectResponse = { ok: true } & Partial<GitHubInstallationStatus>;

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

export async function listLinkableGitHubInstallations(input: {
  account_id: string;
  github_user_token: string;
}) {
  return unwrap(
    await backendApi.post<LinkableGitHubInstallationsResponse>(
      '/projects/github/installations/linkable',
      input,
      { showErrors: false },
    ),
  );
}

export async function listGitHubRepositories(
  accountId: string,
  installationId?: string | null,
  options?: { search?: string; limit?: number },
) {
  const params = new URLSearchParams({ account_id: accountId });
  if (installationId) params.set('installation_id', installationId);
  const search = options?.search?.trim();
  if (search) params.set('search', search);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  return unwrap(
    await backendApi.get<GitHubRepositoriesResponse>(
      `/projects/github/repositories?${params.toString()}`,
      { showErrors: false },
    ),
  );
}

export async function createGitHubConnectSession(input: GitHubConnectSessionInput) {
  return unwrap(
    await backendApi.post<GitHubConnectSessionResponse>(
      '/projects/github/connect-session',
      { account_id: input.accountId },
      { showErrors: false },
    ),
  );
}

export async function createGitHubReconnectSession(input: GitHubConnectionInput) {
  const installationId = encodeURIComponent(input.installationId);
  return unwrap(
    await backendApi.post<GitHubConnectSessionResponse>(
      `/projects/github/installations/${installationId}/reconnect-session`,
      { account_id: input.accountId },
      { showErrors: false },
    ),
  );
}

export async function refreshGitHubConnection(input: GitHubConnectionInput) {
  const installationId = encodeURIComponent(input.installationId);
  return unwrap(
    await backendApi.post<GitHubInstallationStatus>(
      `/projects/github/installations/${installationId}/refresh`,
      { account_id: input.accountId },
      { showErrors: false },
    ),
  );
}

export async function disconnectGitHubConnection(input: GitHubConnectionInput) {
  const installationId = encodeURIComponent(input.installationId);
  const params = new URLSearchParams({ account_id: input.accountId });
  return unwrap(
    await backendApi.delete<GitHubDisconnectResponse>(
      `/projects/github/installations/${installationId}?${params.toString()}`,
      { showErrors: false },
    ),
  );
}

export async function listGitHubRepositoryBranches(
  accountId: string,
  installationId: string,
  repoFullName: string,
) {
  const params = new URLSearchParams({
    account_id: accountId,
    installation_id: installationId,
    repo_full_name: repoFullName,
  });
  return unwrap(
    await backendApi.get<GitHubRepositoryBranchesResponse>(
      `/projects/github/repository-branches?${params.toString()}`,
      { showErrors: false },
    ),
  );
}

export async function saveGitHubInstallation(input: {
  state: string;
  installation_id: string;
  github_user_token?: string;
}) {
  return unwrap(
    await backendApi.post<GitHubInstallationStatus>(
      '/projects/github/installation',
      input,
      { showErrors: false },
    ),
  );
}

export async function linkGitHubInstallation(input: {
  account_id: string;
  installation_id: string;
  github_user_token: string;
}) {
  return unwrap(
    await backendApi.post<GitHubInstallationStatus>(
      '/projects/github/installations/link',
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
