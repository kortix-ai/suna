// GitHub — repository linking and GitHub App installation management.

import { backendApi } from '../../http/api-client';
import { unwrap, type ProjectGitConnection } from './shared';
import type { KortixProject, ProjectGlyph } from './projects';
import type { RepositoryDisconnectedReason } from '../../http/api/errors';

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
  /** Import through the instance git backend ("Kortix managed") instead of an
   *  account connection. Self-host operator only, and mutually exclusive with
   *  `installation_id`. */
  source?: 'managed';
  name?: string;
  default_branch?: string;
  manifest_path?: string;
  /** Optional emoji icon for the new project. Invalid values are dropped
   *  server-side; they never fail the create. */
  icon?: string;
  /** Optional glyph icon for the new project. Invalid values are dropped
   *  rather than failing the create. Wins over `icon` if both are given. */
  icon_glyph?: ProjectGlyph;
}

export interface LinkRepositoryResponse {
  project: KortixProject;
  git_connection: ProjectGitConnection | null;
}

/** @deprecated Use `ReplaceWorkspaceRepositoryInput`. Kept permanently. */
export interface ReplaceProjectRepositoryInput {
  project_id: string;
  repo_url: string;
  expected_repo_url: string;
  /** Stored encrypted per project when using a repository-scoped PAT. */
  github_token?: string;
  /** App installation id. The grant is persisted for this repository only. */
  installation_id?: string;
  /** Temporary GitHub user token used to verify organization admin rights. Never stored. */
  github_user_token?: string;
  /** Copy selected shared runtime secrets atomically during the cutover. */
  copy_shared_secrets_from_project_id?: string;
  copy_shared_secret_identifiers?: string[];
}

/** The workspace name of {@link ReplaceProjectRepositoryInput}: the same type. */
export type ReplaceWorkspaceRepositoryInput = ReplaceProjectRepositoryInput;

/** @deprecated Use `ReplaceWorkspaceRepositoryResponse`. Kept permanently. */
export type ReplaceProjectRepositoryResponse = LinkRepositoryResponse;

/** The workspace name of {@link ReplaceProjectRepositoryResponse}: the same type. */
export type ReplaceWorkspaceRepositoryResponse = ReplaceProjectRepositoryResponse;

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

export interface LinkableGitHubInstallation {
  installation_id: string;
  owner_login: string | null;
  owner_type: string | null;
  repository_selection: string | null;
  permissions: Record<string, unknown>;
  installation_url: string | null;
  linked: boolean;
  /**
   * How many OTHER Kortix accounts already hold this installation. A count
   * only — the API never names them, so one tenant can never read another's
   * name out of this picker.
   */
  linked_to_other_accounts: number;
}

export interface LinkableGitHubInstallationsResponse {
  account_id: string;
  github_login: string;
  configured: boolean;
  install_url: string | null;
  installations: LinkableGitHubInstallation[];
}

/**
 * Is a project's git connection usable, and if not, can the account fix it?
 * `reconnect_required` carries `install_url`, the GitHub App install link that
 * reconnects it. With `reason: 'repository_disconnected'` it also carries
 * `disconnected_reason` and `message` (the cause and the fix).
 *
 * @deprecated Use `WorkspaceGitConnectionState`. Kept permanently.
 */
export interface ProjectGitConnectionState {
  state: 'connected' | 'reconnect_required' | 'unavailable' | 'not_connected';
  reason?: string;
  install_url?: string | null;
  disconnected_reason?: RepositoryDisconnectedReason;
  message?: string;
}

/** The workspace name of {@link ProjectGitConnectionState}: the same type. */
export type WorkspaceGitConnectionState = ProjectGitConnectionState;

/** `GET /projects/:projectId/git/connection`. */
export async function getWorkspaceGitConnectionState(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectGitConnectionState>(`/workspaces/${projectId}/git/connection`),
    'Failed to read the Git connection',
  );
}

/** @deprecated Use `getWorkspaceGitConnectionState`. Kept permanently. */
export const getProjectGitConnectionState = getWorkspaceGitConnectionState;

export async function linkRepository(input: LinkRepositoryInput) {
  return unwrap(
    await backendApi.post<LinkRepositoryResponse>(
      '/workspaces/link-repository',
      input,
      {
        showErrors: false,
      },
    ),
  );
}

/** Change the Git repository for an existing project after validating access. */
export async function replaceWorkspaceRepository(input: ReplaceProjectRepositoryInput) {
  const { project_id, ...body } = input;
  return unwrap(
    await backendApi.put<ReplaceProjectRepositoryResponse>(
      `/workspaces/${encodeURIComponent(project_id)}/git/repository`,
      body,
      { showErrors: false },
    ),
  );
}

/** @deprecated Use `replaceWorkspaceRepository`. Kept permanently. */
export const replaceProjectRepository = replaceWorkspaceRepository;

export async function getGitHubInstallation(accountId: string) {
  return unwrap(
    await backendApi.get<GitHubInstallationsResponse>(
      `/workspaces/github/installation?account_id=${encodeURIComponent(accountId)}`,
      { showErrors: false },
    ),
  );
}

export async function listGitHubInstallations(accountId: string) {
  return unwrap(
    await backendApi.get<GitHubInstallationsResponse>(
      `/workspaces/github/installations?account_id=${encodeURIComponent(accountId)}`,
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
      '/workspaces/github/installations/linkable',
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
      `/workspaces/github/repositories?${params.toString()}`,
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
      `/workspaces/github/repository-branches?${params.toString()}`,
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
      '/workspaces/github/installation',
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
      '/workspaces/github/installations/link',
      input,
      { showErrors: false },
    ),
  );
}

/**
 * Store the caller's GitHub App USER access token for one account.
 *
 * GitHub refuses `POST /user/repos` for an App installation token and accepts a
 * user access token, so creating a repository inside a PERSONAL GitHub account
 * needs the user's own authorization. The browser obtains that token through
 * the GitHub authorization popup; this hands it to the server, which verifies
 * it against GitHub, encrypts it, and never returns it to any caller.
 *
 * `expires_in` is GitHub's own value in seconds, present only when the App is
 * configured to expire user tokens.
 *
 * `showErrors: false`: the caller decides what a failure means — the create
 * flow retries or explains it inline, and a global toast would say the same
 * thing twice.
 */
export async function storeGitHubUserToken(input: {
  account_id: string;
  github_user_token: string;
  expires_in?: number;
  refresh_token?: string;
}) {
  return unwrap(
    await backendApi.post<{ ok: true; github_login: string }>(
      '/workspaces/github/user-token',
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
      `/workspaces/github/installation?${params.toString()}`,
    ),
  );
}
