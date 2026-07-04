// Projects — project CRUD, detail, experimental features, warm pool, onboarding.

import { backendApi, type ApiClientOptions } from '../api-client';
import {
  normalizeServerBackendBase,
  serverTokenGet,
  unwrap,
  type ProjectFileEntry,
  type ProjectGitConnection,
  type ProjectRole,
  type ServerTokenOptions,
} from './shared';

/** Stable ids for experimental features (mirrors apps/api experimental/features). */
export type ExperimentalFeatureKey = 'apps' | 'agent_tunnel' | 'marketplace' | 'agentmail_email' | 'meet' | 'llm_gateway';

/** One experimental feature as described by the API catalog. */
export interface ExperimentalFeatureView {
  key: ExperimentalFeatureKey;
  name: string;
  description: string;
  stability: 'experimental' | 'beta';
  /** Platform supports it (operator env). When false the UI hides the toggle. */
  available: boolean;
  /** Effective per-project state (the switch position). */
  enabled: boolean;
  /** True when this project set an explicit choice (vs inheriting the default). */
  overridden: boolean;
}

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
  /** Effective on/off for each experimental feature for THIS project. */
  experimental?: Record<ExperimentalFeatureKey, boolean>;
  /** Full experimental-feature catalog (drives Customize → Settings →
   *  Experimental). Self-describing so the UI never hard-codes the list. */
  experimental_features?: ExperimentalFeatureView[];
  /** Back-compat alias for `experimental.apps`. */
  apps_enabled?: boolean;
  /** Effective per-project warm sandbox pool config (Customize → Sandbox). */
  warm_pool?: { enabled: boolean; size: number };
  /** Whether the warm pool feature is enabled platform-wide (gates the UI). */
  warm_pool_available?: boolean;
  /** Per-project sandbox-provider pin (Customize → Settings). null = follow the
   *  platform default/distribution. */
  default_sandbox_provider?: string | null;
  /** Enabled sandbox providers the picker offers (ALLOWED ∩ has-API-key). */
  available_sandbox_providers?: string[];
}

export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  open_code_raw: string | null;
  open_code_default_agent: string | null;
  agent_discovery: 'opencode' | 'declarative';
  agents: Array<{
    name: string;
    path: string;
    description: string | null;
    mode: string | null;
    source?: 'opencode' | 'kortix.toml';
    enabled?: boolean;
    /** Per-agent governance from `kortix.toml [[agents]]` (read-only mirror).
     *  `'all'` = unscoped; a list = the allowlist; `[]` = none. Absent for
     *  OpenCode-discovered agents (not governed by [[agents]]). */
    scope?: {
      env: string[] | 'all';
      connectors: string[] | 'all';
      kortix_cli: string[] | 'all';
    };
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

export interface ProjectLlmCatalogResponse {
  models: Record<string, {
    name: string;
    free?: boolean;
    reasoning?: boolean;
    tool_call?: boolean;
    attachment?: boolean;
    temperature?: boolean;
    limit?: { context?: number; output?: number };
  }>;
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
  marketplace_items?: string[];
}

export interface RepoCollaboratorInvite {
  username: string;
  permission: string;
  /** Pending-invitation URL to accept on GitHub, or null if already a collaborator. */
  invitationUrl: string | null;
  alreadyCollaborator: boolean;
}

export async function listProjects() {
  return unwrap(await backendApi.get<KortixProject[]>('/projects'));
}

export async function listProjectsForAccount(accountId?: string) {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(await backendApi.get<KortixProject[]>(`/projects${query}`));
}

export async function getProject(projectId: string, options?: ApiClientOptions) {
  return unwrap(await backendApi.get<KortixProject>(`/projects/${projectId}`, options));
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

export async function getProjectDetail(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<ProjectDetail>(`/projects/${projectId}/detail`, {
      showErrors: false,
      ...options,
    }),
  );
}

export async function getProjectLlmCatalog(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<ProjectLlmCatalogResponse>(`/projects/${projectId}/llm-catalog`, {
      showErrors: false,
      ...options,
    }),
  );
}

export async function createProject(input: ProjectInput) {
  return unwrap(await backendApi.post<KortixProject>('/projects', input));
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

export async function updateProject(
  projectId: string,
  input: Partial<ProjectInput>,
) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}`, input),
  );
}

/** Toggle an experimental feature for a project (Customize → Settings →
 *  Experimental). Pass `enabled: null` to clear the override and fall back to
 *  the operator default. */
export async function updateExperimentalFeature(
  projectId: string,
  feature: ExperimentalFeatureKey,
  enabled: boolean | null,
) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/experimental`, {
      feature,
      enabled,
    }),
  );
}

/** Set or clear the per-project sandbox-provider pin (Customize → Settings).
 *  Pass `null` to clear (follow the platform default/distribution). The value must
 *  be one of the project's `available_sandbox_providers`. */
export async function updateProjectSandboxProvider(
  projectId: string,
  provider: string | null,
) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/sandbox-provider`, {
      provider,
    }),
  );
}

/** @deprecated Use {@link updateExperimentalFeature}('apps', …). */
export async function updateAppsConfig(
  projectId: string,
  input: { enabled: boolean | null },
) {
  return updateExperimentalFeature(projectId, 'apps', input.enabled);
}

/**
 * Configure the warm sandbox pool for one sandbox template (Customize → Sandbox).
 * Warm pool is per-template + opt-in; `slug` selects which template (defaults to
 * the platform default). Live ready/warming counts come back on each template via
 * `listProjectSnapshots`.
 */
export async function updateTemplateWarmPool(
  projectId: string,
  input: { slug: string; enabled?: boolean; size?: number },
) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/warm-pool`, input),
  );
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

// ── Server-side explicit-token variants ──────────────────────────────────────
// Next.js server actions / route handlers (post-signup first-project
// bootstrap) run per-request with an already-resolved Supabase access token —
// they must not rely on the SDK's process-wide `configureKortix()` seam.

/**
 * Server-side / explicit-token variant of {@link listProjectsForAccount}.
 * Returns `null` on any failure.
 */
export async function fetchProjectsForAccountWithToken(
  opts: ServerTokenOptions,
  accountId: string,
): Promise<KortixProject[] | null> {
  return serverTokenGet<KortixProject[]>(
    opts,
    `/v1/projects?account_id=${encodeURIComponent(accountId)}`,
  );
}

export type ProvisionProjectWithTokenResult =
  | { ok: true; project: KortixProject }
  | { ok: false; limitReached: boolean };

/**
 * Server-side / explicit-token variant of {@link provisionProject}. Mirrors
 * the original bootstrap behavior: a 403 with `code: 'project_limit_reached'`
 * is reported distinctly so the caller can fall back to re-listing existing
 * projects instead of treating it as a hard failure.
 */
export async function provisionProjectWithToken(
  opts: ServerTokenOptions,
  input: ProvisionProjectInput,
): Promise<ProvisionProjectWithTokenResult> {
  if (!opts.backendUrl || !opts.accessToken) return { ok: false, limitReached: false };
  const base = normalizeServerBackendBase(opts.backendUrl);
  try {
    const res = await fetch(`${base}/v1/projects/provision`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seed_starter: true, ...input }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
    if (res.ok) {
      const project = (await res.json().catch(() => null)) as KortixProject | null;
      // A 200 whose body doesn't actually carry a project_id is not a usable
      // success — report it as not-ok instead of handing the caller a project
      // it can't build a `/projects/{id}` path from.
      if (!project?.project_id) return { ok: false, limitReached: false };
      return { ok: true, project };
    }
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      return { ok: false, limitReached: body?.code === 'project_limit_reached' };
    }
    return { ok: false, limitReached: false };
  } catch {
    return { ok: false, limitReached: false };
  }
}
