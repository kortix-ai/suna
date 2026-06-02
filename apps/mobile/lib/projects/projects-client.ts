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
