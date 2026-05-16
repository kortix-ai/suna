import { backendApi } from '@/lib/api-client';

export interface KortixProject {
  project_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  manifest_path: string;
  status: 'active' | 'archived';
  metadata: Record<string, unknown>;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  project_role?: ProjectRole | null;
  effective_project_role?: ProjectRole | null;
}

export interface KortixAccount {
  account_id: string;
  name: string;
  slug?: string;
  personal_account?: boolean;
  account_role?: string;
  is_primary_owner?: boolean;
}

export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'manager' | 'editor' | 'viewer';

export interface AccountDetail {
  account_id: string;
  name: string;
  personal_account: boolean;
  member_count: number;
  project_count: number;
  role: AccountRole;
  created_at: string;
  updated_at: string;
}

export interface AccountMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  explicit_project_count?: number;
  joined_at: string;
}

export interface ProjectAccessMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
  has_implicit_access: boolean;
  joined_at: string;
  granted_by: string | null;
  granted_at: string | null;
  updated_at: string | null;
}

export interface ProjectAccessResponse {
  project_id: string;
  account_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: ProjectAccessMember[];
}

export type InviteMemberResult =
  | {
      status: 'added';
      user_id: string;
      email: string;
      account_role: AccountRole;
    }
  | {
      status: 'pending';
      invite_id: string;
      email: string;
      account_role: AccountRole;
      expires_at: string;
    };

export interface AccountInvitation {
  invite_id: string;
  email: string;
  initial_role: AccountRole;
  invited_by: string;
  created_at: string;
  expires_at: string;
}

export interface AccountInviteDescribeFull {
  invite_id: string;
  account_id: string;
  account_name: string | null;
  email: string;
  initial_role: AccountRole;
  inviter_email: string | null;
  created_at: string;
  expires_at: string;
  expired: boolean;
  accepted_at: string | null;
  email_matches_caller: true;
}

export interface AccountInviteDescribeRedacted {
  invite_id: string;
  expired: boolean;
  accepted_at: string | null;
  email_matches_caller: false;
  account_id?: null;
  account_name?: null;
  email?: null;
  initial_role?: null;
  inviter_email?: null;
  created_at?: null;
  expires_at?: null;
}

export type AccountInviteDescribe =
  | AccountInviteDescribeFull
  | AccountInviteDescribeRedacted;

export interface ProjectFileEntry {
  path: string;
  type: 'file';
  size: number | null;
}

export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  open_code_raw: string | null;
  open_code_default_agent: string | null;
  agents: Array<{ name: string; path: string; description: string | null; mode: string | null }>;
  skills: Array<{ name: string; path: string }>;
  env: { required: string[]; optional: string[] };
}

export interface ProjectDetail {
  project: KortixProject;
  config: ProjectConfigSummary;
  file_count: number;
  files: ProjectFileEntry[];
}

export interface ProjectInput {
  account_id?: string;
  name?: string;
  repo_url: string;
  default_branch?: string;
  manifest_path?: string;
}

export interface CreateProjectRepoInput {
  account_id?: string;
  name: string;
  private?: boolean;
  description?: string;
}

export interface GitHubInstallationStatus {
  account_id: string;
  installed: boolean;
  configured: boolean;
  requires_installation: boolean;
  pat_fallback_available: boolean;
  install_url: string | null;
  installation_id: string | null;
  owner_login: string | null;
  owner_type: string | null;
  repository_selection: string | null;
  permissions: Record<string, unknown>;
  updated_at: string | null;
}

export type ProjectChannelPlatform = 'slack' | 'telegram' | 'msteams' | 'discord';
export type IntegrationStatus = 'active' | 'revoked' | 'expired' | 'error';

export interface ProjectChannel {
  channel_id: string;
  account_id: string;
  project_id: string;
  platform: ProjectChannelPlatform;
  external_channel_id: string;
  external_team_id: string | null;
  name: string | null;
  config: Record<string, unknown>;
  agent_name: string;
  prompt_template: string;
  enabled: boolean;
  status: IntegrationStatus;
  metadata: Record<string, unknown>;
  last_message_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectChannelEvent {
  event_id: string;
  channel_id: string;
  account_id: string;
  project_id: string;
  platform: ProjectChannelPlatform;
  external_message_id: string | null;
  status: 'queued' | 'fired' | 'failed';
  payload: Record<string, unknown>;
  rendered_prompt: string | null;
  session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectConnector {
  connector_id: string;
  account_id: string;
  project_id: string;
  provider: string;
  app: string;
  app_name: string | null;
  label: string | null;
  status: IntegrationStatus;
  scopes: string[];
  metadata: Record<string, unknown>;
  provider_account_id?: string;
  connected_at: string;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectOAuthStart {
  provider: string;
  app: string;
  surface: 'connector' | 'channel';
  authorization_url: string;
  redirect_uri: string;
  expires_at: string;
}

export interface ProjectSecret {
  secret_id: string;
  project_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }) {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Project request failed');
  }
  return response.data;
}

export async function listProjects() {
  return unwrap(await backendApi.get<KortixProject[]>('/projects'));
}

export async function listProjectsForAccount(accountId?: string) {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(await backendApi.get<KortixProject[]>(`/projects${query}`));
}

export async function listAccounts() {
  return unwrap(await backendApi.get<KortixAccount[]>('/accounts'));
}

export async function createAccount(input: { name: string }) {
  return unwrap(await backendApi.post<KortixAccount>('/accounts', input));
}

export async function getAccount(accountId: string) {
  return unwrap(await backendApi.get<AccountDetail>(`/accounts/${accountId}`));
}

export async function updateAccountName(accountId: string, name: string) {
  return unwrap(await backendApi.patch<AccountDetail>(`/accounts/${accountId}`, { name }));
}

export async function listAccountMembers(accountId: string) {
  return unwrap(await backendApi.get<AccountMember[]>(`/accounts/${accountId}/members`));
}

export async function inviteAccountMember(
  accountId: string,
  input: { email: string; role?: AccountRole },
) {
  return unwrap(
    await backendApi.post<InviteMemberResult>(`/accounts/${accountId}/members`, input, {
      // 409 (already member) is an expected business error; page surfaces it inline.
      showErrors: false,
    }),
  );
}

export async function listAccountInvites(accountId: string) {
  return unwrap(
    await backendApi.get<AccountInvitation[]>(`/accounts/${accountId}/invites`),
  );
}

export async function cancelAccountInvite(accountId: string, inviteId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/accounts/${accountId}/invites/${inviteId}`,
    ),
  );
}

export async function resendAccountInvite(accountId: string, inviteId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; expires_at: string }>(
      `/accounts/${accountId}/invites/${inviteId}/resend`,
      {},
    ),
  );
}

export async function describeAccountInvite(inviteId: string) {
  return unwrap(
    await backendApi.get<AccountInviteDescribe>(`/account-invites/${inviteId}`, {
      // The redirect/landing page handles "not for you" / expired states inline.
      showErrors: false,
    }),
  );
}

export async function acceptAccountInvite(inviteId: string) {
  return unwrap(
    await backendApi.post<{ account_id: string; account_role: AccountRole }>(
      `/account-invites/${inviteId}/accept`,
      {},
    ),
  );
}

export async function declineAccountInvite(inviteId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean }>(
      `/account-invites/${inviteId}/decline`,
      {},
    ),
  );
}

export async function removeAccountMember(accountId: string, userId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/accounts/${accountId}/members/${userId}`),
  );
}

export async function updateAccountMemberRole(
  accountId: string,
  userId: string,
  role: AccountRole,
) {
  return unwrap(
    await backendApi.patch<AccountMember>(`/accounts/${accountId}/members/${userId}`, { role }),
  );
}

export async function leaveAccount(accountId: string) {
  return unwrap(await backendApi.post<{ ok: boolean }>(`/accounts/${accountId}/leave`, {}));
}

export async function getProject(projectId: string) {
  return unwrap(await backendApi.get<KortixProject>(`/projects/${projectId}`));
}

export async function getProjectDetail(projectId: string) {
  return unwrap(await backendApi.get<ProjectDetail>(`/projects/${projectId}/detail`));
}

export async function listProjectAccess(projectId: string) {
  return unwrap(await backendApi.get<ProjectAccessResponse>(`/projects/${projectId}/access`));
}

export async function updateProjectAccess(
  projectId: string,
  userId: string,
  role: ProjectRole,
) {
  return unwrap(
    await backendApi.put<ProjectAccessMember>(
      `/projects/${projectId}/access/${userId}`,
      { role },
    ),
  );
}

export async function revokeProjectAccess(projectId: string, userId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/access/${userId}`),
  );
}

export async function listProjectSecrets(projectId: string) {
  return unwrap(await backendApi.get<ProjectSecret[]>(`/projects/${projectId}/secrets`));
}

export async function upsertProjectSecret(
  projectId: string,
  input: { name: string; value: string },
) {
  return unwrap(
    await backendApi.post<ProjectSecret>(`/projects/${projectId}/secrets`, input),
  );
}

export async function deleteProjectSecret(projectId: string, name: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
    ),
  );
}

export async function listProjectFiles(
  projectId: string,
  options?: { ref?: string; path?: string },
) {
  const params = new URLSearchParams();
  if (options?.ref) params.set('ref', options.ref);
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(await backendApi.get<ProjectFileEntry[]>(`/projects/${projectId}/files${query}`));
}

export async function readProjectFile(
  projectId: string,
  path: string,
  ref?: string,
) {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  return unwrap(await backendApi.get<{ path: string; ref: string; content: string }>(
    `/projects/${projectId}/files/content?${params.toString()}`,
  ));
}

// ---------------------------------------------------------------------------
// Git history — branches (Versions), commits (Checkpoints), diffs
// ---------------------------------------------------------------------------

export interface ProjectBranch {
  name: string;
  is_default: boolean;
  tip: string;
  tip_short: string;
  subject: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  ahead: number | null;
  behind: number | null;
}

export interface ProjectBranchesResponse {
  default_branch: string;
  branches: ProjectBranch[];
}

export interface ProjectCommit {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  subject: string;
  body: string;
}

export interface ProjectCommitsResponse {
  ref: string;
  path: string | null;
  commits: ProjectCommit[];
  hasMore: boolean;
}

export interface ProjectCommitFile {
  path: string;
  old_path: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  additions: number;
  deletions: number;
}

export interface ProjectCommitDetail extends ProjectCommit {
  files: ProjectCommitFile[];
}

export interface ProjectCommitDiffResponse {
  hash: string;
  parent: string | null;
  path: string | null;
  patch: string;
}

export interface ProjectFileHistoryResponse {
  path: string;
  ref: string;
  commits: ProjectCommit[];
  hasMore: boolean;
}

export async function listProjectBranches(projectId: string) {
  return unwrap(await backendApi.get<ProjectBranchesResponse>(
    `/projects/${projectId}/branches`,
  ));
}

export async function listProjectCommits(
  projectId: string,
  options?: { ref?: string; path?: string; limit?: number; skip?: number },
) {
  const params = new URLSearchParams();
  if (options?.ref) params.set('ref', options.ref);
  if (options?.path) params.set('path', options.path);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.skip != null) params.set('skip', String(options.skip));
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(await backendApi.get<ProjectCommitsResponse>(
    `/projects/${projectId}/commits${query}`,
  ));
}

export async function getProjectCommit(projectId: string, sha: string) {
  return unwrap(await backendApi.get<ProjectCommitDetail>(
    `/projects/${projectId}/commits/${encodeURIComponent(sha)}`,
  ));
}

export async function getProjectCommitDiff(
  projectId: string,
  sha: string,
  options?: { path?: string },
) {
  const params = new URLSearchParams();
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(await backendApi.get<ProjectCommitDiffResponse>(
    `/projects/${projectId}/commits/${encodeURIComponent(sha)}/diff${query}`,
  ));
}

export async function getProjectFileHistory(
  projectId: string,
  path: string,
  options?: { ref?: string; limit?: number; skip?: number },
) {
  const params = new URLSearchParams({ path });
  if (options?.ref) params.set('ref', options.ref);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.skip != null) params.set('skip', String(options.skip));
  return unwrap(await backendApi.get<ProjectFileHistoryResponse>(
    `/projects/${projectId}/files/history?${params.toString()}`,
  ));
}

// ---------------------------------------------------------------------------
// Project sessions — one branch + sandbox per row. session_id == sandbox_id
// == branch_name (same UUID), so "Open session" routes to
// /instances/{session_id}/dashboard.
// ---------------------------------------------------------------------------

export type ProjectSessionStatus =
  | 'queued'
  | 'branching'
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'completed';

export interface ProjectSession {
  session_id: string;
  account_id: string;
  project_id: string;
  branch_name: string;
  base_ref: string;
  sandbox_provider: string | null;
  sandbox_id: string;
  sandbox_url: string | null;
  opencode_session_id: string | null;
  agent_name: string | null;
  status: ProjectSessionStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listProjectSessions(projectId: string) {
  return unwrap(await backendApi.get<ProjectSession[]>(`/projects/${projectId}/sessions`));
}

export async function createProjectSession(
  projectId: string,
  input?: { base_ref?: string; agent_name?: string },
) {
  return unwrap(
    await backendApi.post<ProjectSession>(`/projects/${projectId}/sessions`, input ?? {}),
  );
}

export async function deleteProjectSession(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/sessions/${sessionId}`),
  );
}

// ---------------------------------------------------------------------------
// Session sandbox — runtime row in `kortix.session_sandboxes`. Separate from
// the legacy /instances sandbox table (`kortix.sandboxes`); no billing or
// team-membership coupling. Access gated by `project_members` only.
// ---------------------------------------------------------------------------

export type ProjectSessionSandboxStatus =
  | 'provisioning'
  | 'active'
  | 'stopped'
  | 'error'
  | 'archived';

export interface ProjectSessionSandbox {
  sandbox_id: string;
  session_id: string;
  project_id: string;
  account_id: string;
  provider: 'daytona' | 'local_docker' | 'justavps';
  external_id: string | null;
  base_url: string | null;
  status: ProjectSessionSandboxStatus;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getProjectSessionSandbox(
  projectId: string,
  sessionId: string,
): Promise<ProjectSessionSandbox | null> {
  const response = await backendApi.get<ProjectSessionSandbox>(
    `/projects/${projectId}/sessions/${sessionId}/sandbox`,
    // 404 is an expected "not provisioned yet" state — caller polls.
    { showErrors: false },
  );
  if (!response.success || !response.data) return null;
  return response.data;
}

export async function createProject(input: ProjectInput) {
  return unwrap(await backendApi.post<KortixProject>('/projects', input));
}

export async function createProjectRepo(input: CreateProjectRepoInput) {
  return unwrap(await backendApi.post<KortixProject>('/projects/create-repo', input));
}

export async function getGitHubInstallation(accountId: string) {
  return unwrap(
    await backendApi.get<GitHubInstallationStatus>(
      `/projects/github/installation?account_id=${encodeURIComponent(accountId)}`,
      { showErrors: false },
    ),
  );
}

export async function saveGitHubInstallation(input: {
  account_id: string;
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

export async function deleteGitHubInstallation(accountId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/github/installation?account_id=${encodeURIComponent(accountId)}`,
    ),
  );
}

export async function updateProject(projectId: string, input: Partial<ProjectInput>) {
  return unwrap(await backendApi.patch<KortixProject>(`/projects/${projectId}`, input));
}

export async function archiveProject(projectId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}`));
}

export async function listProjectChannels(projectId: string) {
  return unwrap(await backendApi.get<ProjectChannel[]>(`/projects/${projectId}/channels`));
}

export async function createProjectChannel(
  projectId: string,
  input: {
    platform: ProjectChannelPlatform;
    external_channel_id: string;
    external_team_id?: string | null;
    name?: string | null;
    config?: Record<string, unknown>;
    agent_name?: string;
    prompt_template?: string;
    enabled?: boolean;
    status?: IntegrationStatus;
    metadata?: Record<string, unknown>;
  },
) {
  return unwrap(await backendApi.post<ProjectChannel>(`/projects/${projectId}/channels`, input));
}

export async function updateProjectChannel(
  projectId: string,
  channelId: string,
  input: Partial<{
    external_team_id: string | null;
    name: string | null;
    config: Record<string, unknown>;
    agent_name: string;
    prompt_template: string;
    enabled: boolean;
    status: IntegrationStatus;
    metadata: Record<string, unknown>;
  }>,
) {
  return unwrap(await backendApi.patch<ProjectChannel>(`/projects/${projectId}/channels/${channelId}`, input));
}

export async function deleteProjectChannel(projectId: string, channelId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/channels/${channelId}`));
}

export async function listProjectChannelEvents(projectId: string, channelId: string) {
  return unwrap(await backendApi.get<ProjectChannelEvent[]>(`/projects/${projectId}/channels/${channelId}/events`));
}

export async function startProjectChannelOAuth(
  projectId: string,
  input: {
    platform: ProjectChannelPlatform;
    app?: string;
    scopes?: string[];
    success_redirect_uri?: string;
    error_redirect_uri?: string;
  },
) {
  return unwrap(await backendApi.post<ProjectOAuthStart>(`/projects/${projectId}/channels/oauth/start`, input));
}

export async function listProjectConnectors(projectId: string) {
  return unwrap(await backendApi.get<ProjectConnector[]>(`/projects/${projectId}/connectors`));
}

export async function syncProjectConnectors(projectId: string, input?: { app?: string }) {
  return unwrap(
    await backendApi.post<{ connectors: ProjectConnector[]; synced: number }>(
      `/projects/${projectId}/connectors/sync`,
      input ?? {},
    ),
  );
}

export async function updateProjectConnector(
  projectId: string,
  connectorId: string,
  input: Partial<{
    label: string | null;
    status: IntegrationStatus;
    scopes: string[];
    metadata: Record<string, unknown>;
  }>,
) {
  return unwrap(await backendApi.patch<ProjectConnector>(`/projects/${projectId}/connectors/${connectorId}`, input));
}

export async function deleteProjectConnector(projectId: string, connectorId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/connectors/${connectorId}`));
}

export async function startProjectConnectorOAuth(
  projectId: string,
  input: {
    app: string;
    scopes?: string[];
    success_redirect_uri?: string;
    error_redirect_uri?: string;
  },
) {
  return unwrap(await backendApi.post<ProjectOAuthStart>(`/projects/${projectId}/connectors/oauth/start`, input));
}
