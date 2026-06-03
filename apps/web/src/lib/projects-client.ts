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
  /** Whether the experimental [[apps]] deployment surface is enabled for THIS
   *  project. Per-project override (Customize → Settings) over the operator
   *  default KORTIX_APPS_EXPERIMENTAL. */
  apps_enabled?: boolean;
  /** Effective per-project warm sandbox pool config (Customize → Sandbox). */
  warm_pool?: { enabled: boolean; size: number };
  /** Whether the warm pool feature is enabled platform-wide (gates the UI). */
  warm_pool_available?: boolean;
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
  /** When true the account is on the simplified IAM V2 model (3 account
   *  roles + 3 project roles, no DB-driven policies). Drives whether the
   *  frontend shows the V1 Policies/Roles tabs or the V2 simple UI. */
  iam_v2_enabled?: boolean;
  member_count: number;
  project_count: number;
  role: AccountRole;
  created_at: string;
  updated_at: string;
}

interface AccountMemberGroup {
  group_id: string;
  name: string;
}

export interface AccountMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  is_super_admin?: boolean;
  explicit_project_count?: number;
  groups?: AccountMemberGroup[];
  /** Number of active CLI Personal Access Tokens this user owns in
   *  this account. Lets the UI flag members with API automation. */
  active_pat_count?: number;
  /** True when the user has at least one verified MFA factor in
   *  Supabase Auth. */
  has_verified_mfa?: boolean;
  joined_at: string;
}

interface ProjectGroupAccessSource {
  group_id: string;
  group_name: string;
  role: ProjectRole;
}

export interface ProjectAccessMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
  has_implicit_access: boolean;
  /** Which path produced effective_project_role. 'implicit' = account
   *  owner/admin; 'direct' = explicit project_members row; 'group' =
   *  inherited via a project_group_grants attachment. null = no access. */
  effective_source?: 'implicit' | 'direct' | 'group' | null;
  /** Every group attachment that includes this user, sorted by role
   *  desc. Used to label "via X group" on the row. */
  group_sources?: ProjectGroupAccessSource[];
  joined_at: string;
  granted_by: string | null;
  granted_at: string | null;
  updated_at: string | null;
  /** Auto-revoke timestamp for the DIRECT grant (ISO). null = permanent
   *  or no direct grant. */
  expires_at?: string | null;
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
      invite_url: string;
      email_sent: boolean;
      email_skip_reason: string | null;
    };

export interface AccountInvitation {
  invite_id: string;
  email: string;
  initial_role: AccountRole;
  invited_by: string;
  created_at: string;
  expires_at: string;
  invite_url: string;
}

export interface ResendInviteResult {
  ok: boolean;
  expires_at: string;
  invite_url: string;
  email_sent: boolean;
  email_skip_reason: string | null;
}

interface AccountInviteDescribeFull {
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

interface AccountInviteDescribeRedacted {
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
  agents: Array<{
    name: string;
    path: string;
    description: string | null;
    mode: string | null;
  }>;
  skills: Array<{ name: string; path: string; description: string | null }>;
  commands: Array<{ name: string; path: string; description: string | null }>;
  env: { required: string[]; optional: string[] };
}

export interface ProjectDetail {
  project: KortixProject;
  git_connection?: ProjectGitConnection | null;
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
  installation_id?: string;
  private?: boolean;
  description?: string;
  starter_template?: 'general-knowledge-worker' | 'minimal';
}

export interface ProvisionProjectInput {
  account_id?: string;
  name: string;
  /** Seed the managed repo with the Kortix starter so sessions can boot. */
  seed_starter?: boolean;
  starter_template?: 'general-knowledge-worker' | 'minimal';
}

export interface ProjectGitConnection {
  connection_id: string;
  account_id: string;
  project_id: string;
  provider: string;
  repo_url: string;
  repo_owner: string | null;
  repo_name: string | null;
  external_repo_id: string | null;
  default_branch: string;
  auth_method: string;
  installation_id: string | null;
  visibility: string | null;
  status: string;
  last_validated_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

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

/**
 * The per-user view of one secret KEY: the shared/project row merged with the
 * requesting member's own override, plus which one wins for them at runtime.
 */
export interface ProjectSecret {
  name: string;
  project_id: string;
  /** Shared row id; null when only a personal override (or nothing) exists. */
  secret_id: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  system?: boolean;
  readonly?: boolean;
  purpose?: string | null;
  can_rotate?: boolean;
  managed_by?: string | null;
  /** A shared/project value is set. */
  configured: boolean;
  /** Persisted share scope — 'project' (everyone) or 'restricted' (allow-list). */
  share_scope?: 'project' | 'restricted';
  /** Who can use the shared value. Same shape as connector sharing. */
  sharing?: ConnectorSharing | null;
  /** The shared value reaches me (project-wide, or I'm in the allow-list). */
  usable_by_me: boolean;
  /** My own per-key override (value never returned), and whether it's active. */
  mine: { active: boolean; updated_at: string } | null;
  /** What actually runs in my sessions for this key. */
  effective_source: 'mine' | 'shared' | 'none';
  /** I'm allowed to edit the shared row (project manager). */
  can_manage_shared: boolean;
}

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }) {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Project request failed');
  }
  return response.data;
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
  return unwrap(
    await backendApi.patch<AccountDetail>(`/accounts/${accountId}`, { name }),
  );
}

export async function listAccountMembers(accountId: string) {
  return unwrap(
    await backendApi.get<AccountMember[]>(`/accounts/${accountId}/members`),
  );
}

export async function inviteAccountMember(
  accountId: string,
  input: { email: string; role?: AccountRole },
) {
  return unwrap(
    await backendApi.post<InviteMemberResult>(
      `/accounts/${accountId}/members`,
      input,
      {
        // 409 (already member) is an expected business error; page surfaces it inline.
        showErrors: false,
      },
    ),
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
    await backendApi.post<ResendInviteResult>(
      `/accounts/${accountId}/invites/${inviteId}/resend`,
      {},
    ),
  );
}

export async function describeAccountInvite(inviteId: string) {
  return unwrap(
    await backendApi.get<AccountInviteDescribe>(
      `/account-invites/${inviteId}`,
      {
        // The redirect/landing page handles "not for you" / expired states inline.
        showErrors: false,
      },
    ),
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
    await backendApi.delete<{ ok: boolean }>(
      `/accounts/${accountId}/members/${userId}`,
    ),
  );
}

export async function updateAccountMemberRole(
  accountId: string,
  userId: string,
  role: AccountRole,
) {
  return unwrap(
    await backendApi.patch<AccountMember>(
      `/accounts/${accountId}/members/${userId}`,
      { role },
    ),
  );
}

export async function leaveAccount(accountId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean }>(`/accounts/${accountId}/leave`, {}),
  );
}

export async function getProject(projectId: string) {
  return unwrap(await backendApi.get<KortixProject>(`/projects/${projectId}`));
}

export interface RepoCollaboratorInvite {
  username: string;
  permission: string;
  /** Pending-invitation URL to accept on GitHub, or null if already a collaborator. */
  invitationUrl: string | null;
  alreadyCollaborator: boolean;
}

/**
 * Invite a GitHub user as a collaborator on a MANAGED repo — lets the project
 * creator pull "their" Kortix-managed repo into their own GitHub account.
 */
export async function inviteRepoCollaborator(
  projectId: string,
  githubUsername: string,
  permission: 'read' | 'write' = 'write',
) {
  return unwrap(
    await backendApi.post<RepoCollaboratorInvite>(
      `/projects/${projectId}/git/collaborators`,
      { github_username: githubUsername, permission },
    ),
  );
}

/** True when this project's repo is a Kortix-managed GitHub repo (invitable). */
export function isManagedGithubProject(project: { metadata?: Record<string, unknown> | null }): boolean {
  const git = (project.metadata as { git?: { provider?: string; managed?: boolean } } | undefined)?.git;
  return git?.provider === 'github' && git?.managed === true;
}

export async function getProjectDetail(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectDetail>(`/projects/${projectId}/detail`),
  );
}

export async function listProjectAccess(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectAccessResponse>(
      `/projects/${projectId}/access`,
    ),
  );
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
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/access/${userId}`,
    ),
  );
}

/** Two-shape response:
 *  - User had a Kortix account already → ProjectAccessMember row was
 *    inserted/updated; UI refreshes the access list and shows them.
 *  - User had no Kortix account → an account invitation was created
 *    with a bootstrap_grant. UI shows "invitation sent" and skips the
 *    access-list refresh (the user won't appear until they accept). */
export type InviteProjectMemberResult =
  | ProjectAccessMember
  | {
      status: 'invited';
      email: string;
      invite_id: string;
      project_role: ProjectRole;
      message: string;
      /** Public invite link — share manually when email delivery is skipped. */
      invite_url: string;
      /** false = invite email skipped (e.g. Mailtrap unconfigured) or failed. */
      email_sent: boolean;
      email_skip_reason: string | null;
    };

export function isInviteSent(
  r: InviteProjectMemberResult,
): r is Extract<InviteProjectMemberResult, { status: 'invited' }> {
  return 'status' in r && r.status === 'invited';
}

export async function inviteProjectMember(
  projectId: string,
  email: string,
  role: ProjectRole,
) {
  return unwrap(
    await backendApi.post<InviteProjectMemberResult>(
      `/projects/${projectId}/access/invite`,
      { email, role },
    ),
  );
}

// ── Pending project invites (non-Kortix users who haven't signed up yet) ──

/** Pending account-invitation that bootstraps into THIS project on accept.
 *  Shape mirrors the backend GET /access/pending-invites response.
 *
 *  `expires_at` here is the *grant's* time-bounded clock (auto-revoke once
 *  they're in). `invite_expires_at` is the *invitation* clock — after that
 *  the user can't redeem the link and needs a resend. */
export interface PendingProjectInvite {
  invite_id: string;
  email: string;
  project_role: ProjectRole;
  expires_at: string | null;
  invited_by_email: string | null;
  created_at: string;
  invite_expires_at: string;
  invite_expired: boolean;
}

export async function listPendingProjectInvites(projectId: string) {
  return unwrap(
    await backendApi.get<{ pending: PendingProjectInvite[] }>(
      `/projects/${projectId}/access/pending-invites`,
    ),
  );
}

export async function revokePendingProjectInvite(projectId: string, inviteId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean; invitation_cancelled: boolean }>(
      `/projects/${projectId}/access/pending-invites/${inviteId}`,
    ),
  );
}

export interface ResendProjectInviteResult {
  ok: boolean;
  expires_at: string;
  invite_url: string;
  email_sent: boolean;
  email_skip_reason: string | null;
}

export async function resendPendingProjectInvite(projectId: string, inviteId: string) {
  return unwrap(
    await backendApi.post<ResendProjectInviteResult>(
      `/projects/${projectId}/access/pending-invites/${inviteId}/resend`,
    ),
  );
}

// ── IAM V2: project ⇄ group attachments ────────────────────────────────────

export interface ProjectGroupGrant {
  group_id: string;
  group_name: string;
  role: ProjectRole;
  granted_by: string | null;
  created_at: string;
  /** Auto-revoke timestamp (ISO). null = permanent. */
  expires_at?: string | null;
  /** Total members in this group. */
  member_count?: number;
  /** Members who are account owners/admins — they get implicit Manager
   *  on every project, so this grant's role doesn't apply to them. */
  override_count?: number;
}

export async function listProjectGroupGrants(projectId: string) {
  return unwrap(
    await backendApi.get<{ grants: ProjectGroupGrant[] }>(
      `/projects/${projectId}/group-grants`,
    ),
  );
}

export async function attachGroupToProject(
  projectId: string,
  groupId: string,
  role: ProjectRole,
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.post<{ project_id: string; group_id: string; role: ProjectRole }>(
      `/projects/${projectId}/group-grants`,
      // undefined = field omitted (don't touch); null = clear expiry.
      expiresAt === undefined
        ? { group_id: groupId, role }
        : { group_id: groupId, role, expires_at: expiresAt },
    ),
  );
}

export async function updateProjectGroupGrant(
  projectId: string,
  groupId: string,
  role: ProjectRole,
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.patch<{ project_id: string; group_id: string; role: ProjectRole }>(
      `/projects/${projectId}/group-grants/${groupId}`,
      expiresAt === undefined ? { role } : { role, expires_at: expiresAt },
    ),
  );
}

export async function detachGroupFromProject(projectId: string, groupId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/group-grants/${groupId}`,
    ),
  );
}

export interface ProjectSecretsResponse {
  items: ProjectSecret[];
  /** Whether the requesting member can edit shared rows (vs only their own overrides). */
  can_manage?: boolean;
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
    await backendApi.get<ProjectSecretsResponse>(
      `/projects/${projectId}/secrets`,
    ),
  );
}

export async function upsertProjectSecret(
  projectId: string,
  input: {
    name: string;
    /** Omit to change sharing only on an existing secret (value left untouched). */
    value?: string;
    sharing?: ConnectorSharing;
  },
) {
  return unwrap(
    await backendApi.post<ProjectSecret>(
      `/projects/${projectId}/secrets`,
      input,
    ),
  );
}

export async function startProjectChatGptHeadlessAuth(projectId: string) {
  return unwrap(
    await backendApi.post<{
      authId: string;
      url: string;
      instructions: string;
      code: string | null;
    }>(
      `/projects/${projectId}/providers/openai/chatgpt/headless/start`,
      {},
    ),
  );
}

export async function completeProjectChatGptHeadlessAuth(
  projectId: string,
  input: { authId: string; sharing?: ConnectorSharing },
) {
  return unwrap(
    await backendApi.post<ProjectSecret>(
      `/projects/${projectId}/providers/openai/chatgpt/headless/complete`,
      { auth_id: input.authId, sharing: input.sharing },
    ),
  );
}

export async function upsertProjectGitCredential(
  projectId: string,
  input: { token: string },
) {
  return unwrap(
    await backendApi.put<{
      configured: boolean;
      provider: string;
      git_connection: ProjectGitConnection;
    }>(`/projects/${projectId}/git-credential`, input),
  );
}

export async function deleteProjectSecret(projectId: string, name: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
    ),
  );
}

/**
 * Set/update the caller's OWN per-key override ("use mine") and/or flip whether
 * it's active. Any project member may call this; it never touches the shared
 * value or anyone else's override.
 */
export async function setPersonalProjectSecret(
  projectId: string,
  name: string,
  input: { value?: string; active?: boolean },
) {
  return unwrap(
    await backendApi.put<ProjectSecret>(
      `/projects/${projectId}/secrets/${encodeURIComponent(name)}/personal`,
      input,
    ),
  );
}

/** Remove the caller's own override for a key (falls back to the shared value). */
export async function deletePersonalProjectSecret(projectId: string, name: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/secrets/${encodeURIComponent(name)}/personal`,
    ),
  );
}

// ─── Executor connectors ──────────────────────────────────────────────────

export interface ConnectorAction {
  path: string;
  name: string;
  description: string;
  risk: 'read' | 'write' | 'destructive';
  inputSchema: Record<string, unknown> | null;
}

export type ConnectorSharing =
  | { mode: 'project' }
  | { mode: 'private'; ownerId: string }
  | { mode: 'members'; memberIds?: string[]; groupIds?: string[] };

export interface AdminConnector {
  slug: string;
  name: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http';
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
  /** Credential storage model — one shared project credential vs each member's own. */
  credentialMode: 'shared' | 'per_user';
  actions: ConnectorAction[];
  authSecret: string | null;
  sharing: ConnectorSharing | null;
  secretSet: boolean;
}

export interface ConnectorsResponse {
  connectors: AdminConnector[];
}

export interface ConnectorSyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

export async function listConnectors(projectId: string) {
  return unwrap(
    await backendApi.get<ConnectorsResponse>(`/executor/projects/${projectId}/connectors`),
  );
}

export async function syncConnectors(projectId: string) {
  return unwrap(
    await backendApi.post<ConnectorSyncResult>(`/executor/projects/${projectId}/connectors/sync`, {}),
  );
}

export async function setConnectorSharing(
  projectId: string,
  slug: string,
  intent: ConnectorSharing,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/sharing`,
      intent,
    ),
  );
}

export async function pipedreamConnect(projectId: string, slug: string) {
  return unwrap(
    await backendApi.post<{ token?: string; app?: string; connectUrl?: string }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/connect`,
      {},
    ),
  );
}

export interface ConnectorDraftInput {
  slug: string;
  name?: string;
  provider: AdminConnector['provider'];
  app?: string;
  account?: string;
  url?: string;
  transport?: 'http' | 'sse';
  endpoint?: string;
  baseUrl?: string;
  spec?: string;
  /** Credential storage mode. */
  credential?: 'shared' | 'per_user';
  /** Access — who can use it (applied after create). */
  sharing?: ConnectorSharing;
  auth?: {
    type?: 'none' | 'bearer' | 'basic' | 'custom';
    in?: 'header' | 'query';
    name?: string;
    prefix?: string;
  };
}

export async function createConnector(projectId: string, draft: ConnectorDraftInput) {
  return unwrap(
    await backendApi.post<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/projects/${projectId}/connectors`,
      draft,
    ),
  );
}

export async function deleteConnector(projectId: string, slug: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}`,
    ),
  );
}

export interface PipedreamApp {
  slug: string;
  name: string;
  description: string | null;
  imgSrc: string | null;
  categories: string[];
}

export async function listPipedreamApps(projectId: string, q?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return unwrap(
    await backendApi.get<{ apps: PipedreamApp[]; nextCursor?: string; hasMore: boolean }>(
      `/executor/projects/${projectId}/pipedream/apps${qs ? `?${qs}` : ''}`,
    ),
  );
}

export async function setConnectorCredential(projectId: string, slug: string, value: string) {
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/credential`,
      { value },
    ),
  );
}

// ─── Executor policies (kortix.toml-backed) ────────────────────────────────

export type PolicyAction = 'always_run' | 'require_approval' | 'block';
export type PolicyDefaultMode = 'risk' | 'allow_all';

export interface ProjectPolicy {
  match: string;
  action: PolicyAction;
}

export interface ProjectPoliciesResponse {
  policies: ProjectPolicy[];
  defaultMode: PolicyDefaultMode;
  errors: Array<{ path: string; error: string }>;
}

export async function listProjectPolicies(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectPoliciesResponse>(`/executor/projects/${projectId}/policies`),
  );
}

export async function setProjectPolicies(
  projectId: string,
  policies: ProjectPolicy[],
  defaultMode: PolicyDefaultMode,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/projects/${projectId}/policies`,
      { policies, defaultMode },
    ),
  );
}

export async function pipedreamFinalize(projectId: string, slug: string) {
  return unwrap(
    await backendApi.post<{ connected: boolean; accountId?: string }>(
      `/executor/projects/${projectId}/connectors/${encodeURIComponent(slug)}/connect/finalize`,
      {},
    ),
  );
}

// ─── Sandbox templates + snapshot build log ──────────────────────────────

/** Lifecycle status of a single build attempt. */
export type ProjectSnapshotStatus = 'building' | 'ready' | 'failed';

/** Classified reason a snapshot build failed. */
export type SnapshotErrorCategory =
  | 'dockerfile'
  | 'tunnel'
  | 'provider'
  | 'timeout'
  | 'runtime'
  | 'git'
  | 'unknown';

/** A sandbox template: platform default + each `[[sandbox.templates]]` / UI-created entry. */
export interface SandboxTemplate {
  template_id: string | null;
  slug: string;
  name: string;
  is_default: boolean;
  source: 'platform' | 'toml' | 'ui';
  provider: string;
  has_dockerfile: boolean;
  has_image: boolean;
  image: string | null;
  dockerfile_path: string | null;
  entrypoint: string | null;
  cpu: number;
  memory_gb: number;
  disk_gb: number;
  snapshot_name: string;
  content_hash: string;
  built_from_commit: string | null;
  daytona_state: string;
  provider_state: string;
  ready: boolean;
}

export interface SandboxTemplatesResponse {
  items: SandboxTemplate[];
  default_slug: string | null;
}

export interface ProjectSnapshotBuild {
  build_id: string;
  slug: string;
  snapshot_name: string;
  content_hash: string;
  status: ProjectSnapshotStatus;
  error: string | null;
  error_category: SnapshotErrorCategory | null;
  source: 'session-start' | 'project-create' | 'cr-merge' | 'manual' | 'background' | 'startup' | null;
  started_at: string;
  finished_at: string | null;
}

export interface ProjectSnapshotsResponse {
  templates: SandboxTemplate[];
  templates_error: string | null;
  builds: ProjectSnapshotBuild[];
}

export interface ProjectSandboxHealth {
  primary_slug: string | null;
  primary_template: SandboxTemplate | null;
  ready: boolean;
  building: boolean;
  latest_build: ProjectSnapshotBuild | null;
  latest_failure: ProjectSnapshotBuild | null;
}

export interface RebuildSnapshotResponse {
  status: 'started';
  slug: string;
  deleted_existing: boolean;
  snapshot_name: string;
}

export async function listProjectSandboxes(projectId: string) {
  return unwrap(
    await backendApi.get<SandboxTemplatesResponse>(
      `/projects/${projectId}/sandboxes`,
    ),
  );
}

export async function listProjectSnapshots(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSnapshotsResponse>(
      `/projects/${projectId}/snapshots`,
    ),
  );
}

export async function getProjectSandboxHealth(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSandboxHealth>(
      `/projects/${projectId}/sandbox-health`,
    ),
  );
}

export async function rebuildProjectSnapshot(projectId: string, slug?: string) {
  return unwrap(
    await backendApi.post<RebuildSnapshotResponse>(
      `/projects/${projectId}/snapshots/rebuild`,
      slug ? { slug } : {},
    ),
  );
}

export async function fixSandboxWithAgent(projectId: string) {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${projectId}/snapshots/fix-with-agent`,
      {},
    ),
  );
}

// ─── Template CRUD ────────────────────────────────────────────────────────

export interface CreateSandboxTemplateInput {
  slug: string;
  name?: string;
  image?: string;
  dockerfile_path?: string;
  entrypoint?: string;
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
}

export interface UpdateSandboxTemplateInput {
  name?: string;
  image?: string | null;
  dockerfile_path?: string | null;
  entrypoint?: string | null;
  cpu?: number | null;
  memory_gb?: number | null;
  disk_gb?: number | null;
}

export async function createSandboxTemplate(
  projectId: string,
  input: CreateSandboxTemplateInput,
) {
  return unwrap(
    await backendApi.post<{ template_id: string; slug: string }>(
      `/projects/${projectId}/sandbox-templates`,
      input,
    ),
  );
}

export async function updateSandboxTemplate(
  projectId: string,
  templateId: string,
  input: UpdateSandboxTemplateInput,
) {
  return unwrap(
    await backendApi.patch<{ template_id: string; slug: string }>(
      `/projects/${projectId}/sandbox-templates/${templateId}`,
      input,
    ),
  );
}

export async function deleteSandboxTemplate(projectId: string, templateId: string) {
  return unwrap(
    await backendApi.delete<null>(
      `/projects/${projectId}/sandbox-templates/${templateId}`,
    ),
  );
}

export async function buildSandboxTemplate(projectId: string, templateId: string) {
  return unwrap(
    await backendApi.post<{ status: 'started'; template_id: string; slug: string }>(
      `/projects/${projectId}/sandbox-templates/${templateId}/build`,
      {},
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
  return unwrap(
    await backendApi.get<ProjectFileEntry[]>(
      `/projects/${projectId}/files${query}`,
    ),
  );
}

export interface ProjectFileSearchMatch {
  path: string;
  /** Present for content search (git grep). */
  line_number?: number;
  line_text?: string;
}

export interface ProjectFileSearchResponse {
  query: string;
  ref: string;
  content_search: boolean;
  results: ProjectFileSearchMatch[];
}

/** Search the project's git repo — filenames by default, contents when
 *  `content` is true (server-side `git grep`). */
export async function searchProjectFiles(
  projectId: string,
  query: string,
  options?: { content?: boolean; ref?: string; limit?: number },
) {
  const params = new URLSearchParams({ q: query });
  if (options?.content) params.set('content', '1');
  if (options?.ref) params.set('ref', options.ref);
  if (options?.limit) params.set('limit', String(options.limit));
  return unwrap(
    await backendApi.get<ProjectFileSearchResponse>(
      `/projects/${projectId}/files/search?${params.toString()}`,
    ),
  );
}

export async function readProjectFile(
  projectId: string,
  path: string,
  ref?: string,
) {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  return unwrap(
    await backendApi.get<{ path: string; ref: string; content: string }>(
      `/projects/${projectId}/files/content?${params.toString()}`,
    ),
  );
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
  status:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'typechange';
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
  return unwrap(
    await backendApi.get<ProjectBranchesResponse>(
      `/projects/${projectId}/branches`,
    ),
  );
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
  return unwrap(
    await backendApi.get<ProjectCommitsResponse>(
      `/projects/${projectId}/commits${query}`,
    ),
  );
}

export async function getProjectCommit(projectId: string, sha: string) {
  return unwrap(
    await backendApi.get<ProjectCommitDetail>(
      `/projects/${projectId}/commits/${encodeURIComponent(sha)}`,
    ),
  );
}

export async function getProjectCommitDiff(
  projectId: string,
  sha: string,
  options?: { path?: string },
) {
  const params = new URLSearchParams();
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<ProjectCommitDiffResponse>(
      `/projects/${projectId}/commits/${encodeURIComponent(sha)}/diff${query}`,
    ),
  );
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
  return unwrap(
    await backendApi.get<ProjectFileHistoryResponse>(
      `/projects/${projectId}/files/history?${params.toString()}`,
    ),
  );
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
  return unwrap(
    await backendApi.get<VersionDiffPreview>(
      `/projects/${projectId}/version-diff?${params.toString()}`,
    ),
  );
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
  return unwrap(
    await backendApi.get<{ change_requests: ChangeRequest[] }>(
      `/projects/${projectId}/change-requests${query}`,
    ),
  );
}

export async function getChangeRequest(projectId: string, crId: string) {
  return unwrap(
    await backendApi.get<ChangeRequestDetailResponse>(
      `/projects/${projectId}/change-requests/${crId}`,
    ),
  );
}

export async function getChangeRequestDiff(projectId: string, crId: string) {
  return unwrap(
    await backendApi.get<ChangeRequestDiffResponse>(
      `/projects/${projectId}/change-requests/${crId}/diff`,
    ),
  );
}

export async function getChangeRequestMergePreview(
  projectId: string,
  crId: string,
) {
  return unwrap(
    await backendApi.get<ChangeRequestMergePreview>(
      `/projects/${projectId}/change-requests/${crId}/merge-preview`,
    ),
  );
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
  return unwrap(
    await backendApi.post<ChangeRequest>(
      `/projects/${projectId}/change-requests`,
      input,
    ),
  );
}

export async function mergeChangeRequest(
  projectId: string,
  crId: string,
  input?: { message?: string },
) {
  return unwrap(
    await backendApi.post<ChangeRequestMergeResponse>(
      `/projects/${projectId}/change-requests/${crId}/merge`,
      input ?? {},
    ),
  );
}

export async function closeChangeRequest(projectId: string, crId: string) {
  return unwrap(
    await backendApi.post<ChangeRequest>(
      `/projects/${projectId}/change-requests/${crId}/close`,
      {},
    ),
  );
}

export async function reopenChangeRequest(projectId: string, crId: string) {
  return unwrap(
    await backendApi.post<ChangeRequest>(
      `/projects/${projectId}/change-requests/${crId}/reopen`,
      {},
    ),
  );
}

export interface CommitSessionResult {
  committed: boolean;
  pushed: boolean;
  nothing_to_do: boolean;
  branch: string | null;
  head_sha: string | null;
}

/**
 * Commit + push the session sandbox's pending changes to its branch — the
 * host-driven step that lets the UI open a change request without asking the
 * agent. Idempotent on the server.
 *
 * NOTE (2026-05-29): currently UNUSED. The shipped flow asks the agent to
 * commit + open the change request from a chat prompt. Kept for a possible
 * fully-UI flow (see the API endpoint /sessions/:id/commit-push).
 */
export async function commitSessionChanges(
  projectId: string,
  sessionId: string,
  input?: { message?: string },
) {
  return unwrap(
    await backendApi.post<CommitSessionResult>(
      `/projects/${projectId}/sessions/${sessionId}/commit-push`,
      input ?? {},
    ),
  );
}

// ---------------------------------------------------------------------------
// Project sessions — one branch + sandbox per row. session_id == sandbox_id
// == branch_name (same UUID), so "Open session" routes to
// /projects/{project_id}/sessions/{session_id}.
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
   * /v1/projects/sync-opencode-sessions. Backed by metadata.name in the DB.
   */
  name: string | null;
  agent_name: string | null;
  status: ProjectSessionStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  opencode_sessions: ProjectOpenCodeSession[];
  // Ownership + org-visibility (Phase 2 session sharing).
  created_by?: string | null;
  owner_email?: string | null;
  visibility?: 'private' | 'project' | 'restricted';
  sharing?: ConnectorSharing | null;
  is_owner?: boolean;
  can_manage_sharing?: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectOpenCodeSession {
  id: string;
  title: string | null;
  parent_id: string | null;
  project_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  archived_at: number | null;
}

export async function listProjectSessions(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSession[]>(`/projects/${projectId}/sessions`),
  );
}

/**
 * Set who can see/open a session (private | project | members). Owner or
 * project manager only. Reuses the connector/secret sharing intent shape.
 */
export async function setProjectSessionSharing(
  projectId: string,
  sessionId: string,
  intent: ConnectorSharing,
) {
  return unwrap(
    await backendApi.put<ProjectSession>(
      `/projects/${projectId}/sessions/${sessionId}/sharing`,
      intent,
    ),
  );
}

export async function createProjectSession(
  projectId: string,
  input?: {
    base_ref?: string;
    agent_name?: string;
    /** Slug of the sandbox template to boot from. Defaults to "default". */
    sandbox_slug?: string;
    initial_prompt?: string;
    name?: string;
    /**
     * Client-generated session id. The API accepts any RFC 4122 v4 UUID;
     * we use this so the FE can navigate optimistically the moment the user
     * clicks "send" — the page renders before the POST has even returned.
     */
    session_id?: string;
  },
) {
  return unwrap(
    await backendApi.post<ProjectSession>(
      `/projects/${projectId}/sessions`,
      input ?? {},
    ),
  );
}

export async function getProjectSession(
  projectId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.get<ProjectSession>(
      `/projects/${projectId}/sessions/${sessionId}`,
    ),
  );
}

/**
 * Backend-owned OpenCode↔Kortix mapping. The API resolves the sandbox's
 * canonical OpenCode root id and persists it to opencode_session_id (creating
 * one if the sandbox has none, healing a stale pin). Idempotent. The returned
 * session row carries the authoritative `opencode_session_id`, plus an
 * `ensure` summary of what happened. Clients must NOT set the pin themselves.
 */
export async function ensureOpencodeSession(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<
      ProjectSession & {
        ensure?: {
          reason: 'unchanged' | 'healed' | 'created' | 'not_ready' | 'unreachable';
          changed: boolean;
          pin: string | null;
        };
      }
    >(`/projects/${projectId}/sessions/${sessionId}/ensure-opencode`, {}),
  );
}

export async function deleteProjectSession(
  projectId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/sessions/${sessionId}`,
    ),
  );
}

export async function restartProjectSession(
  projectId: string,
  sessionId: string,
) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/projects/${projectId}/sessions/${sessionId}/restart`,
      {},
    ),
  );
}

/**
 * Wake a sandbox the provider auto-stopped while idle. Cheap status no-op when
 * it's running; starts it in the background when stopped. Fire on session open
 * so an idled sandbox warms immediately instead of spinning the health poll.
 */
export async function wakeProjectSession(projectId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ status: 'running' | 'waking' | 'unknown' }>(
      `/projects/${projectId}/sessions/${sessionId}/wake`,
      {},
    ),
  );
}

export interface SyncOpencodeSessionEntry {
  opencode_session_id: string;
  title: string | null;
  parent_id?: string | null;
  project_id?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  archived_at?: number | null;
}

export async function syncOpencodeSessionData(
  entries: SyncOpencodeSessionEntry[],
) {
  if (entries.length === 0) return { updated: 0 };
  return unwrap(
    await backendApi.post<{ updated: number }>(
      `/projects/sync-opencode-sessions`,
      { entries },
    ),
  );
}

// ---------------------------------------------------------------------------
// Triggers — file-defined in the project repo at `.opencode/triggers/<slug>.md`
// (YAML frontmatter + markdown prompt body). The cloud API parses these on
// every read; CRUD endpoints commit/delete the files via the GitHub Contents
// API. The repo is the source of truth; runtime state (last_fired_at) lives
// in `project_trigger_runtime` so a fire doesn't amplify into a git commit.
// ---------------------------------------------------------------------------

type ProjectTriggerType = 'cron' | 'webhook';

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
  /** ISO-8601 instant for a one-off ("run once") schedule; null for recurring/webhook. */
  run_at: string | null;
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
interface ProjectTriggerParseError {
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
  /** For type='cron'. 6-field croner expression. Omit when using `run_at`. */
  cron?: string;
  /** For type='cron'. ISO-8601 instant for a one-off run. Mutually exclusive with `cron`. */
  run_at?: string;
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
    await backendApi.get<ProjectTriggerListing>(
      `/projects/${projectId}/triggers`,
    ),
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

type ProjectSessionSandboxStatus =
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

export async function createProjectRepo(input: CreateProjectRepoInput) {
  return unwrap(
    await backendApi.post<KortixProject>('/projects/create-repo', input),
  );
}

/**
 * Create a project backed by a managed Kortix git repo — the
 * default. No GitHub account or repo-name uniqueness needed; the starter is
 * seeded server-side so the project boots immediately.
 */
export async function provisionProject(input: ProvisionProjectInput) {
  return unwrap(
    await backendApi.post<KortixProject>('/projects/provision', {
      seed_starter: true,
      ...input,
    }),
  );
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

export async function updateProject(
  projectId: string,
  input: Partial<ProjectInput>,
) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}`, input),
  );
}

/** Toggle the experimental [[apps]] surface for a project (Customize →
 *  Settings). Pass `enabled: null` to clear the override and fall back to the
 *  operator default. */
export async function updateAppsConfig(
  projectId: string,
  input: { enabled: boolean | null },
) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/apps-config`, input),
  );
}

/** Configure the per-project warm sandbox pool (Customize → Sandbox). */
export async function updateWarmPool(
  projectId: string,
  input: { enabled?: boolean; size?: number },
) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/warm-pool`, input),
  );
}

export interface WarmPoolStatus {
  available: boolean;
  enabled: boolean;
  size: number;
  /** Sandboxes parked and ready to claim instantly. */
  ready: number;
  /** Sandboxes currently booting toward ready. */
  warming: number;
}

/** Live warm pool config + status (ready / warming counts). */
export async function getWarmPoolStatus(projectId: string): Promise<WarmPoolStatus> {
  return unwrap(await backendApi.get<WarmPoolStatus>(`/projects/${projectId}/warm-pool`));
}

export async function setProjectOnboardingComplete(
  projectId: string,
  completed: boolean,
) {
  return unwrap(
    await backendApi.patch<KortixProject>(
      `/projects/${projectId}/onboarding`,
      { completed },
    ),
  );
}

export async function archiveProject(projectId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}`),
  );
}
