import { backendApi } from '@/lib/api-client';
import { getSupabaseAccessTokenWithRetry } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';

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
  is_super_admin?: boolean;
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
  skills: Array<{ name: string; path: string; description: string | null }>;
  commands: Array<{ name: string; path: string; description: string | null }>;
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

export interface ProjectSecretsResponse {
  items: ProjectSecret[];
  /** Env keys declared as required in the project's kortix.toml manifest. */
  required: string[];
  /** Env keys declared as optional in the project's kortix.toml manifest. */
  optional: string[];
  /**
   * 'loaded'  → kortix.toml read successfully (env lists are authoritative).
   * 'missing' → manifest file not present in the repo.
   * 'error'   → couldn't fetch/parse the repo (private repo, network, etc.).
   */
  manifest_status?: 'loaded' | 'missing' | 'error';
  /** Path the API tried (defaults to "kortix.toml" but configurable per project). */
  manifest_path?: string;
  /** Error string when manifest_status === 'error'. */
  manifest_error?: string;
}

export async function listProjectSecrets(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSecretsResponse>(`/projects/${projectId}/secrets`),
  );
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

// ─── Sandbox snapshots ────────────────────────────────────────────────────

/** Build status of a project's Daytona snapshot row. */
export type ProjectSnapshotStatus = 'queued' | 'building' | 'ready' | 'failed';

export interface ProjectSnapshot {
  snapshot_row_id: string;
  project_id: string;
  provider: string;
  commit_sha: string;
  branch: string;
  snapshot_id: string | null;
  status: ProjectSnapshotStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectSnapshotsResponse {
  items: ProjectSnapshot[];
  default_branch: string;
  /** Current HEAD on the default branch. Null if the API couldn't resolve it. */
  head_commit_sha: string | null;
  /** Error string when head_commit_sha is null (e.g. GitHub App not installed). */
  head_resolve_error: string | null;
}

export interface RebuildSnapshotResponse {
  status: 'already-ready' | 'already-building' | 'started' | 'failed-to-start';
  branch: string;
  commit_sha: string | null;
}

export async function listProjectSnapshots(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSnapshotsResponse>(`/projects/${projectId}/snapshots`),
  );
}

export async function rebuildProjectSnapshot(projectId: string) {
  return unwrap(
    await backendApi.post<RebuildSnapshotResponse>(
      `/projects/${projectId}/snapshots/rebuild`,
      {},
    ),
  );
}

// ─── OAuth credentials (ChatGPT Pro/Plus headless + GitHub Copilot) ─────

export type OauthProviderId = 'openai' | 'github-copilot';

export interface ProjectOauthCredential {
  provider_id: OauthProviderId;
  account_id: string | null;
  enterprise_url: string | null;
  expires: number;
  expires_in_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface OauthCredentialsResponse {
  items: ProjectOauthCredential[];
  supported: OauthProviderId[];
}

export interface OauthStartResponse {
  flow_id: string;
  provider_id: OauthProviderId;
  verification_url: string;
  user_code: string;
  interval_ms: number;
  expires_at: number;
}

export type OauthPollResponse =
  | { status: 'pending'; next_poll_ms: number }
  | { status: 'success'; credential: ProjectOauthCredential }
  | { status: 'expired' }
  | { status: 'failed'; error: string };

export async function listProjectOauthCredentials(projectId: string) {
  return unwrap(
    await backendApi.get<OauthCredentialsResponse>(`/projects/${projectId}/oauth`),
  );
}

export async function startProjectOauthFlow(
  projectId: string,
  provider: OauthProviderId,
  input?: { enterprise_url?: string },
) {
  return unwrap(
    await backendApi.post<OauthStartResponse>(
      `/projects/${projectId}/oauth/${provider}/start`,
      input ?? {},
    ),
  );
}

export async function pollProjectOauthFlow(
  projectId: string,
  provider: OauthProviderId,
  flowId: string,
) {
  return unwrap(
    await backendApi.post<OauthPollResponse>(
      `/projects/${projectId}/oauth/${provider}/poll`,
      { flow_id: flowId },
    ),
  );
}

export async function deleteProjectOauthCredential(
  projectId: string,
  provider: OauthProviderId,
) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/oauth/${encodeURIComponent(provider)}`,
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

/**
 * Fetch a binary zip archive of a project repo (or subtree) as a Blob.
 *
 * Uses the same auth as `backendApi` but bypasses its JSON-only unwrap so we
 * can stream `application/zip` directly.
 */
export async function fetchProjectArchive(
  projectId: string,
  ref: string,
  path?: string,
): Promise<Blob> {
  const params = new URLSearchParams();
  if (ref) params.set('ref', ref);
  if (path) params.set('path', path);
  const query = params.toString() ? `?${params.toString()}` : '';

  const token = await getSupabaseAccessTokenWithRetry();
  const url = `${getEnv().BACKEND_URL || ''}/projects/${projectId}/files/archive${query}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to download (HTTP ${res.status})`);
  }
  return await res.blob();
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
// Change Requests — Kortix-native PR layer. Backend-agnostic: the underlying
// merge runs via apps/api/.../git.ts against whichever git host the project's
// repo URL points to.
//
// v1 is deliberately minimal — no reviews, no comments, no mirrored revision
// history. Just open / merged / closed plus the live diff against base.
// ---------------------------------------------------------------------------

export type ChangeRequestStatus = 'open' | 'merged' | 'closed';

export interface ChangeRequest {
  cr_id: string;
  account_id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  base_ref: string;
  head_ref: string;
  status: ChangeRequestStatus;
  head_commit_sha: string | null;
  base_commit_sha: string | null;
  origin_session_id: string | null;
  created_by: string;
  merged_at: string | null;
  merged_by: string | null;
  merge_commit_sha: string | null;
  closed_at: string | null;
  closed_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ChangeRequestDetailResponse {
  change_request: ChangeRequest;
}

export interface ChangeRequestDiffResponse {
  cr_id: string;
  base_ref: string;
  head_ref: string;
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  files: ProjectCommitFile[];
  files_changed: number;
  additions: number;
  deletions: number;
  patch: string;
}

export interface ChangeRequestMergePreview {
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  can_fast_forward: boolean;
  can_merge: boolean;
  conflicts: string[];
  is_up_to_date: boolean;
}

export interface VersionDiffPreview {
  from: string;
  into: string;
  from_sha: string | null;
  into_sha: string | null;
  merge_base: string | null;
  files_changed: number;
  additions: number;
  deletions: number;
  is_up_to_date: boolean;
  is_same_ref: boolean;
}

export async function getVersionDiff(
  projectId: string,
  input: { from: string; into: string },
) {
  const params = new URLSearchParams({ from: input.from, into: input.into });
  return unwrap(await backendApi.get<VersionDiffPreview>(
    `/projects/${projectId}/version-diff?${params.toString()}`,
  ));
}

export interface ChangeRequestMergeResponse {
  change_request: ChangeRequest;
  merge: {
    merge_commit_sha: string;
    fast_forward: boolean;
    base_sha_before: string;
    base_sha_after: string;
  };
}

export async function listChangeRequests(
  projectId: string,
  status?: ChangeRequestStatus | 'all',
) {
  const query = status ? `?status=${status}` : '';
  return unwrap(await backendApi.get<{ change_requests: ChangeRequest[] }>(
    `/projects/${projectId}/change-requests${query}`,
  ));
}

export async function getChangeRequest(projectId: string, crId: string) {
  return unwrap(await backendApi.get<ChangeRequestDetailResponse>(
    `/projects/${projectId}/change-requests/${crId}`,
  ));
}

export async function getChangeRequestDiff(projectId: string, crId: string) {
  return unwrap(await backendApi.get<ChangeRequestDiffResponse>(
    `/projects/${projectId}/change-requests/${crId}/diff`,
  ));
}

export async function getChangeRequestMergePreview(projectId: string, crId: string) {
  return unwrap(await backendApi.get<ChangeRequestMergePreview>(
    `/projects/${projectId}/change-requests/${crId}/merge-preview`,
  ));
}

export async function openChangeRequest(
  projectId: string,
  input: {
    title: string;
    description?: string;
    head_ref: string;
    base_ref?: string;
    session_id?: string;
  },
) {
  return unwrap(await backendApi.post<ChangeRequest>(
    `/projects/${projectId}/change-requests`,
    input,
  ));
}

export async function mergeChangeRequest(
  projectId: string,
  crId: string,
  input?: { message?: string },
) {
  return unwrap(await backendApi.post<ChangeRequestMergeResponse>(
    `/projects/${projectId}/change-requests/${crId}/merge`,
    input ?? {},
  ));
}

export async function closeChangeRequest(projectId: string, crId: string) {
  return unwrap(await backendApi.post<ChangeRequest>(
    `/projects/${projectId}/change-requests/${crId}/close`,
    {},
  ));
}

export async function reopenChangeRequest(projectId: string, crId: string) {
  return unwrap(await backendApi.post<ChangeRequest>(
    `/projects/${projectId}/change-requests/${crId}/reopen`,
    {},
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
  /**
   * Session title, mirrored from opencode's session.title via
   * /v1/projects/sync-opencode-titles. Backed by metadata.name in the DB.
   */
  name: string | null;
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

export async function restartProjectSession(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/projects/${projectId}/sessions/${sessionId}/restart`,
      {},
    ),
  );
}

export interface SyncOpencodeTitleEntry {
  opencode_session_id: string;
  title: string | null;
}

export async function syncOpencodeSessionTitles(entries: SyncOpencodeTitleEntry[]) {
  if (entries.length === 0) return { updated: 0 };
  return unwrap(
    await backendApi.post<{ updated: number }>(`/projects/sync-opencode-titles`, { entries }),
  );
}

// ---------------------------------------------------------------------------
// Triggers — file-defined in the project repo at `.opencode/triggers/<slug>.md`
// (YAML frontmatter + markdown prompt body). The cloud API parses these on
// every read; CRUD endpoints commit/delete the files via the GitHub Contents
// API. The repo is the source of truth; runtime state (last_fired_at) lives
// in `project_trigger_runtime` so a fire doesn't amplify into a git commit.
// ---------------------------------------------------------------------------

export type ProjectTriggerType = 'cron' | 'webhook';

/** Parsed trigger spec — what the listing endpoint returns. */
export interface ProjectTrigger {
  /** URL-safe slug (the filename minus `.md`). */
  slug: string;
  /** Where the entry is sourced from. Always `kortix.toml#triggers.<slug>`
   *  now that triggers are centralized in the manifest. */
  path: string;
  name: string;
  type: ProjectTriggerType;
  agent: string;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  /** project_secrets key holding the webhook HMAC secret. */
  secret_env: string | null;
  prompt_template: string;
  last_fired_at: string | null;
  /** Public fire URL for webhook triggers; null for cron. */
  webhook_url: string | null;
}

/** Parse error surfaced by the listing endpoint so the UI can render
 * broken triggers next to green ones. */
export interface ProjectTriggerParseError {
  slug: string;
  path: string;
  error: string;
}

export interface ProjectTriggerListing {
  triggers: ProjectTrigger[];
  errors: ProjectTriggerParseError[];
}

export interface CreateProjectTriggerInput {
  /** Required — used as the title and shown in the UI. */
  name: string;
  /**
   * Optional slug override. When omitted, derived from `name`. Once
   * created, the slug is immutable (changing it would orphan runtime state).
   */
  slug?: string;
  type: ProjectTriggerType;
  prompt_template: string;
  /** Defaults to 'default'. */
  agent?: string;
  enabled?: boolean;
  /** For type='cron'. 6-field croner expression. */
  cron?: string;
  /** For type='cron'. IANA timezone. Defaults to 'UTC'. */
  timezone?: string;
  /** For type='webhook'. Name of a project_secrets entry. */
  secret_env?: string;
}

export interface UpdateProjectTriggerInput {
  name?: string;
  prompt_template?: string;
  agent?: string;
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  secret_env?: string;
}

export async function listProjectTriggers(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectTriggerListing>(`/projects/${projectId}/triggers`),
  );
}

export async function createProjectTrigger(
  projectId: string,
  input: CreateProjectTriggerInput,
) {
  return unwrap(
    await backendApi.post<ProjectTriggerListing>(
      `/projects/${projectId}/triggers`,
      input,
    ),
  );
}

export async function updateProjectTrigger(
  projectId: string,
  slug: string,
  input: UpdateProjectTriggerInput,
) {
  return unwrap(
    await backendApi.patch<ProjectTriggerListing>(
      `/projects/${projectId}/triggers/${slug}`,
      input,
    ),
  );
}

export async function deleteProjectTrigger(projectId: string, slug: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/triggers/${slug}`,
    ),
  );
}

export interface FireProjectTriggerResponse {
  status: 'fired' | 'queued' | 'failed';
  session_id?: string | null;
  reason?: string;
  error?: string;
}

export async function fireProjectTrigger(projectId: string, slug: string) {
  return unwrap(
    await backendApi.post<FireProjectTriggerResponse>(
      `/projects/${projectId}/triggers/${slug}/fire`,
      {},
    ),
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
