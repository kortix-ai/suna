/**
 * Projects data client — web-aligned (mirrors apps/web/src/lib/projects-client.ts).
 *
 * Hits the same repo-first backend endpoints the web app uses
 * (GET /accounts, GET /projects?account_id=, etc.) on API_URL (:8008/v1).
 */

import { API_URL, getAuthToken } from '@/api/config';

// ── Types (mirror web) ─────────────────────────────────────────────────────

export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'manager' | 'editor' | 'viewer';

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

export interface ProvisionProjectInput {
  account_id?: string;
  name: string;
  seed_starter?: boolean;
  starter_template?: 'general-knowledge-worker' | 'minimal';
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
  git_connection: Record<string, unknown> | null;
}

// ── Fetch helper ───────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `Request failed (${res.status})`;
    try {
      const body = JSON.parse(text);
      message = body.message || body.error || body.detail || message;
    } catch {
      if (text) message = text.slice(0, 200);
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Accounts ───────────────────────────────────────────────────────────────

export function listAccounts() {
  return apiFetch<KortixAccount[]>('/accounts');
}

export function createAccount(name: string) {
  return apiFetch<KortixAccount>('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

// ── Projects ───────────────────────────────────────────────────────────────

export function listProjectsForAccount(accountId?: string) {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return apiFetch<KortixProject[]>(`/projects${query}`);
}

export function getProject(projectId: string) {
  return apiFetch<KortixProject>(`/projects/${encodeURIComponent(projectId)}`);
}

// ── Project sessions (one branch + sandbox per row; web-aligned) ────────────

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
  name: string | null;
  agent_name: string | null;
  status: ProjectSessionStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectSessionInput {
  session_id?: string;
  name?: string;
  initial_prompt?: string;
  base_ref?: string;
  agent_name?: string;
  sandbox_slug?: string;
}

export function listProjectSessions(projectId: string) {
  return apiFetch<ProjectSession[]>(`/projects/${encodeURIComponent(projectId)}/sessions`);
}

export function createProjectSession(projectId: string, input: CreateProjectSessionInput = {}) {
  return apiFetch<ProjectSession>(`/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type EnsureOpencodeReason =
  | 'unchanged'
  | 'healed'
  | 'created'
  | 'not_ready'
  | 'unreachable';

export interface EnsureOpencodeResult extends ProjectSession {
  ensure?: { reason: EnsureOpencodeReason; changed: boolean; pin: string | null };
}

/**
 * Backend-owned OpenCode↔Kortix mapping (web parity). The API resolves the
 * sandbox's canonical OpenCode root id and persists it to opencode_session_id,
 * creating one if missing / healing a stale pin. Idempotent. The returned row
 * carries the authoritative `opencode_session_id`; `ensure.reason` is
 * `not_ready`/`unreachable` while the sandbox/runtime is still warming — the
 * caller should retry. Clients must NOT set the pin themselves.
 */
export function ensureOpencodeSession(projectId: string, sessionId: string) {
  return apiFetch<EnsureOpencodeResult>(
    `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/ensure-opencode`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export interface ProjectSessionSandbox {
  sandbox_id: string;
  session_id: string;
  project_id: string;
  account_id: string;
  provider: string | null;
  external_id: string | null;
  base_url: string | null;
  /** 'provisioning' | 'active' | 'error' | 'stopped' | 'archived' */
  status: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Fetch a session's sandbox runtime row. CRITICAL (web parity): this GET has a
 * SIDE EFFECT — when there's no usable sandbox it kicks (re)provisioning on the
 * backend (kickProvisionOnOpen). The web's session page polls it every ~300ms,
 * which is what actually drives the sandbox to 'active'. Returns null on 404
 * ('not provisioned yet' — keep polling).
 */
export async function getProjectSessionSandbox(
  projectId: string,
  sessionId: string,
): Promise<ProjectSessionSandbox | null> {
  try {
    return await apiFetch<ProjectSessionSandbox>(
      `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/sandbox`,
    );
  } catch {
    return null;
  }
}

export type WakeStatus = 'running' | 'waking' | 'provisioning' | 'unknown';

/**
 * Wake a sandbox the provider auto-stopped while idle (web parity). The DB row
 * still reads `running` after an idle auto-stop, so opening hits a dead
 * container and ensure-opencode spins on `not_ready`/`unreachable` forever. This
 * returns instantly — a running sandbox is a no-op; a stopped one is started in
 * the background while the ensure retry picks up readiness.
 */
export function wakeProjectSession(projectId: string, sessionId: string) {
  return apiFetch<{ status: WakeStatus }>(
    `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/wake`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/**
 * Tear down and re-provision a session's runtime (web parity:
 * restartProjectSession). Used to recover a sandbox whose runtime failed to
 * boot — e.g. a repo-materialization/git-clone failure surfaced via
 * /kortix/health `boot_error`. The caller should re-drive the connect loop
 * after this resolves.
 */
export function restartProjectSession(projectId: string, sessionId: string) {
  return apiFetch<{ ok: boolean; session_id: string; status: string }>(
    `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/restart`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

// ── Project config detail (agents / skills / commands) ───────────────────────
// Web parity: GET /projects/:id/detail returns the repo's OpenCode config —
// the agents, skills and slash-commands declared under .kortix/opencode/.

export interface ProjectConfigEntry {
  name: string;
  path: string;
  description: string | null;
}
export interface ProjectAgentEntry extends ProjectConfigEntry {
  /** 'primary' | 'subagent' | null */
  mode: string | null;
}
export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  open_code_default_agent: string | null;
  agents: ProjectAgentEntry[];
  skills: ProjectConfigEntry[];
  commands: ProjectConfigEntry[];
  env: { required: string[]; optional: string[] };
}
export interface ProjectDetail {
  project: KortixProject;
  config: ProjectConfigSummary;
  file_count: number;
}

export function getProjectDetail(projectId: string) {
  return apiFetch<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}/detail`);
}

/** Read a repo file's content at the project's default ref (for config source views). */
export function readProjectFile(projectId: string, path: string, ref?: string) {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  return apiFetch<{ path: string; ref: string; content: string }>(
    `/projects/${encodeURIComponent(projectId)}/files/content?${params.toString()}`,
  );
}

// ── Executor connectors (web parity: connectors-view) ────────────────────────
// Project-scoped tool connectors: Pipedream 1-click OAuth apps, MCP servers, and
// custom OpenAPI/GraphQL/HTTP integrations. Endpoints live under /executor.

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

export type ConnectorProvider = 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http';

export interface AdminConnector {
  slug: string;
  name: string;
  provider: ConnectorProvider;
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
  /** One shared project credential vs each member's own. */
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

export interface PipedreamApp {
  slug: string;
  name: string;
  description: string | null;
  imgSrc: string | null;
  categories: string[];
}

export interface PipedreamAppsPage {
  apps: PipedreamApp[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface ConnectorDraftInput {
  slug: string;
  name?: string;
  provider: ConnectorProvider;
  app?: string;
  account?: string;
  url?: string;
  transport?: 'http' | 'sse';
  endpoint?: string;
  baseUrl?: string;
  spec?: string;
  credential?: 'shared' | 'per_user';
  sharing?: ConnectorSharing;
  auth?: { type?: 'none' | 'bearer' | 'basic' | 'custom'; in?: 'header' | 'query'; name?: string; prefix?: string };
}

const connectorsBase = (projectId: string) =>
  `/executor/projects/${encodeURIComponent(projectId)}/connectors`;

export function listConnectors(projectId: string) {
  return apiFetch<ConnectorsResponse>(connectorsBase(projectId));
}

export function syncConnectors(projectId: string) {
  return apiFetch<ConnectorSyncResult>(`${connectorsBase(projectId)}/sync`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function deleteConnector(projectId: string, slug: string) {
  return apiFetch<{ ok: boolean }>(`${connectorsBase(projectId)}/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
}

export function setConnectorSharing(projectId: string, slug: string, intent: ConnectorSharing) {
  return apiFetch<{ ok: boolean }>(
    `${connectorsBase(projectId)}/${encodeURIComponent(slug)}/sharing`,
    { method: 'PUT', body: JSON.stringify(intent) },
  );
}

export function setConnectorCredential(projectId: string, slug: string, value: string) {
  return apiFetch<{ ok: boolean }>(
    `${connectorsBase(projectId)}/${encodeURIComponent(slug)}/credential`,
    { method: 'PUT', body: JSON.stringify({ value }) },
  );
}

export function createConnector(projectId: string, draft: ConnectorDraftInput) {
  return apiFetch<{ ok: boolean; sync?: ConnectorSyncResult }>(connectorsBase(projectId), {
    method: 'POST',
    body: JSON.stringify(draft),
  });
}

/** Begin a Pipedream 1-click connect. Returns a `connectUrl` to open in a browser. */
export function pipedreamConnect(projectId: string, slug: string) {
  return apiFetch<{ token?: string; app?: string; connectUrl?: string }>(
    `${connectorsBase(projectId)}/${encodeURIComponent(slug)}/connect`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/** Finalize a Pipedream connect once the OAuth flow returns. */
export function pipedreamFinalize(projectId: string, slug: string) {
  return apiFetch<{ connected: boolean; accountId?: string }>(
    `${connectorsBase(projectId)}/${encodeURIComponent(slug)}/connect/finalize`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/** Searchable, paginated Pipedream app catalogue (Easy Connect). */
export function listPipedreamApps(projectId: string, q?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return apiFetch<PipedreamAppsPage>(
    `/executor/projects/${encodeURIComponent(projectId)}/pipedream/apps${qs ? `?${qs}` : ''}`,
  );
}

// ── Project access (members) — for the connector sharing member picker ───────

export interface ProjectAccessMember {
  user_id: string;
  email: string | null;
}
export interface ProjectAccessResponse {
  viewer_user_id?: string;
  members: ProjectAccessMember[];
}

export function listProjectAccess(projectId: string) {
  return apiFetch<ProjectAccessResponse>(`/projects/${encodeURIComponent(projectId)}/access`);
}

// ── Executor policies (tool-approval rules) ──────────────────────────────────
// Allow / Ask-first / Block rules matched against tool paths, plus the default
// behaviour for unmatched tools.

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

export function listProjectPolicies(projectId: string) {
  return apiFetch<ProjectPoliciesResponse>(`/executor/projects/${encodeURIComponent(projectId)}/policies`);
}

export function setProjectPolicies(
  projectId: string,
  policies: ProjectPolicy[],
  defaultMode: PolicyDefaultMode,
) {
  return apiFetch<{ ok: boolean }>(`/executor/projects/${encodeURIComponent(projectId)}/policies`, {
    method: 'PUT',
    body: JSON.stringify({ policies, defaultMode }),
  });
}

export function archiveProject(projectId: string) {
  return apiFetch<{ ok: boolean }>(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
}

export function provisionProject(input: ProvisionProjectInput) {
  return apiFetch<KortixProject>('/projects/provision', {
    method: 'POST',
    body: JSON.stringify({ seed_starter: true, ...input }),
  });
}

// ── GitHub import ──────────────────────────────────────────────────────────

export function listGitHubInstallations(accountId: string) {
  return apiFetch<GitHubInstallationsResponse>(
    `/projects/github/installations?account_id=${encodeURIComponent(accountId)}`,
  );
}

export function listGitHubRepositories(accountId: string, installationId?: string | null) {
  const params = new URLSearchParams({ account_id: accountId });
  if (installationId) params.set('installation_id', installationId);
  return apiFetch<GitHubRepositoriesResponse>(
    `/projects/github/repositories?${params.toString()}`,
  );
}

export function linkRepository(input: LinkRepositoryInput) {
  return apiFetch<LinkRepositoryResponse>('/projects/link-repository', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ── Project secrets (web parity: customize/sections/secrets-view) ─────────────
// Two layers per KEY: a shared (project) value managers control, and each
// member's optional personal override. Values are write-only — never returned.

export interface ProjectSecret {
  name: string;
  project_id: string;
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
  share_scope?: 'project' | 'restricted';
  sharing?: ConnectorSharing | null;
  /** The shared value reaches me. */
  usable_by_me: boolean;
  /** My personal override (value never included). */
  mine: { active: boolean; updated_at: string } | null;
  /** What actually runs in MY sessions. */
  effective_source: 'mine' | 'shared' | 'none';
  /** I may edit the shared row. */
  can_manage_shared: boolean;
}

export interface ProjectSecretsResponse {
  items: ProjectSecret[];
  can_manage?: boolean;
  required: string[];
  optional: string[];
  manifest_status?: 'loaded' | 'missing' | 'error';
  manifest_path?: string;
  manifest_error?: string;
}

const secretsBase = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/secrets`;

export async function listProjectSecrets(projectId: string): Promise<ProjectSecretsResponse> {
  const res = await apiFetch<ProjectSecretsResponse | ProjectSecret[]>(secretsBase(projectId));
  // Defend against a legacy bare-array response shape.
  if (Array.isArray(res)) return { items: res, required: [], optional: [] };
  return { ...res, items: res.items ?? [] };
}

export function upsertProjectSecret(
  projectId: string,
  input: { name: string; value?: string; sharing?: ConnectorSharing },
) {
  return apiFetch<ProjectSecret>(secretsBase(projectId), {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteProjectSecret(projectId: string, name: string) {
  return apiFetch<{ ok: boolean }>(`${secretsBase(projectId)}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export function setPersonalProjectSecret(
  projectId: string,
  name: string,
  input: { value?: string; active?: boolean },
) {
  return apiFetch<ProjectSecret>(
    `${secretsBase(projectId)}/${encodeURIComponent(name)}/personal`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

export function deletePersonalProjectSecret(projectId: string, name: string) {
  return apiFetch<{ ok: boolean }>(
    `${secretsBase(projectId)}/${encodeURIComponent(name)}/personal`,
    { method: 'DELETE' },
  );
}

// ── Channels — Slack (web parity: customize/sections/channels-view) ───────────
// One Slack workspace install per project. Either 1-click OAuth ("Add to
// Slack", when the server has Slack creds) or BYO (paste a bot token + signing
// secret from your own Slack app manifest).

export interface SlackInstallation {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

export interface SlackMode {
  oauth_available: boolean;
  install_url: string | null;
}

const channelsBase = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/channels`;

/** Current Slack install, or null when not connected. */
export function getSlackInstallation(projectId: string) {
  return apiFetch<SlackInstallation | null>(`${channelsBase(projectId)}/slack/installation`);
}

/** Whether 1-click OAuth is available + the pre-signed install URL. */
export function getSlackMode(projectId: string) {
  return apiFetch<SlackMode>(`${channelsBase(projectId)}/slack/mode`);
}

/** BYO connect: validate a bot token + signing secret against Slack. */
export function connectSlack(
  projectId: string,
  input: { bot_token: string; signing_secret: string },
) {
  return apiFetch<SlackInstallation>(`${channelsBase(projectId)}/slack/connect`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Remove the Slack install (deletes its secrets, stops events). */
export function disconnectSlack(projectId: string) {
  return apiFetch<{ status: string }>(`${channelsBase(projectId)}/slack/installation`, {
    method: 'DELETE',
  });
}
