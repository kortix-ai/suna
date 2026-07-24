// Projects — project CRUD, detail, experimental features, warm pool, onboarding.

import { type ApiClientOptions, backendApi } from '../../http/api-client';
import type { SandboxProviderName } from '../platform-client/types';
import {
  type ProjectFileEntry,
  type ProjectGitConnection,
  type ProjectRole,
  type ServerTokenOptions,
  normalizeServerBackendBase,
  serverTokenGet,
  unwrap,
} from './shared';

/** Stable ids for experimental features (mirrors apps/api experimental/features).
 *  NOTE: this mirror is now complete against the authoritative registry —
 *  `@kortix/api-contract`'s `ExperimentalFeatureMapSchema`
 *  (`packages/api-contract/src/index.ts`). Keep both in sync when either
 *  side adds a key. See PROGRESS.md Discovered-this-session (DISC-07). */
export type ExperimentalFeatureKey =
  | 'agent_tunnel'
  | 'marketplace'
  | 'connectors_api_discover'
  | 'agentmail_email'
  | 'meet'
  | 'llm_gateway'
  | 'review_center';

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
  /** Effective per-project warm sandbox pool config (Customize → Sandbox). */
  warm_pool?: { enabled: boolean; size: number };
  /** Whether the warm pool feature is enabled platform-wide (gates the UI). */
  warm_pool_available?: boolean;
  /** Per-project sandbox-provider pin (Customize → Settings). null = follow the
   *  platform default/distribution. */
  default_sandbox_provider?: SandboxProviderName | null;
  /** Enabled sandbox providers the picker offers (ALLOWED ∩ has-API-key). */
  available_sandbox_providers?: SandboxProviderName[];
}

export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  runtime_configs: Array<{
    runtime: string;
    harness: 'claude' | 'codex' | 'opencode' | 'pi';
    config_dir: string;
    path: string;
    raw: string | null;
  }>;
  runtime_config_raw: string | null;
  runtime_default_agent: string | null;
  agent_source: 'native' | 'declarative';
  /** @deprecated Use agent_source. */
  agent_discovery: 'runtime' | 'declarative';
  agents: Array<{
    name: string;
    path: string;
    description: string | null;
    mode: string | null;
    source?: 'runtime' | 'opencode' | 'kortix.toml' | 'kortix.yaml';
    enabled?: boolean;
    /** kortix.yaml v3 runtime profile selected by this logical agent. */
    runtime?: string | null;
    /** ACP harness resolved by the single runtime compiler entrypoint. */
    harness?: 'claude' | 'codex' | 'opencode' | 'pi' | null;
    native_agent?: string | null;
    /** Per-agent governance from `kortix.yaml` `agents:` (read-only mirror).
     *  `'all'` = unscoped; a list = the allowlist; `[]` = none. Absent for
     *  Runtime-discovered agents (not governed by `agents:`). */
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

/**
 * A single model as served by the project LLM catalog endpoint. Mirrors the
 * API's `GatewayModel` (apps/api/src/llm-gateway/models/catalog-models.ts) —
 * keep the two in sync. Declaring the full shape here is what lets the web's
 * `flattenModels` read `provider` (and the models.dev passthrough fields)
 * without an `as any` cast: this interface is the only place between the API
 * and the picker where the field could go undeclared.
 */
export interface GatewayCatalogModel {
  name: string;
  free?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  limit?: { context?: number; output?: number };
  variants?: Record<string, Record<string, unknown>>;
  /**
   * The REAL upstream provider serving this model ('anthropic', 'openai',
   * 'amazon-bedrock', ...). Every gateway model is registered under the one
   * synthetic `kortix` opencode provider, so this is the ONLY reliable way to
   * group/label a model by who actually serves it — Bedrock ids are
   * dot-namespaced (`us.anthropic.claude-opus-4-8`), so the legacy
   * split-on-slash heuristic cannot recover it.
   */
  provider?: string;
  release_date?: string;
  released?: string;
  family?: string;
  cost?: { input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning_options?: Array<{ type: string; values?: string[]; min?: number; max?: number }>;
  description?: string;
  open_weights?: boolean;
  last_updated?: string;
}

export interface ProjectLlmCatalogResponse {
  models: Record<string, GatewayCatalogModel>;
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
  /** Clone a `registry:project` item into the new GitHub repository. */
  source_item_id?: string;
}

export interface ProvisionProjectInput {
  account_id?: string;
  name: string;
  /** Seed the managed repo with the Kortix starter so sessions can boot. */
  seed_starter?: boolean;
  starter_template?: 'general-knowledge-worker' | 'minimal';
  marketplace_items?: string[];
  /** Clone a `registry:project` marketplace item instead of the blank
   *  starter — e.g. `"kortix-projects:support-agent-kit"`. Implies
   *  seed_starter and takes precedence over starter_template. */
  source_item_id?: string;
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
    await backendApi.post<RepoCollaboratorInvite>(`/projects/${projectId}/git/collaborators`, {
      github_username: githubUsername,
      permission,
    }),
  );
}

export interface ManifestValidationIssue {
  [key: string]: unknown;
}

export interface ManifestValidationResult {
  valid: boolean;
  issues: ManifestValidationIssue[];
}

/**
 * Validate a `kortix.toml` manifest's raw TOML text server-side — the same
 * schema the CLI (`kortix ship` pre-flight / `kortix validate`) and the CR-merge
 * gate exercise. Always resolves (never throws on an invalid manifest) — the
 * verdict is in the body.
 */
export async function validateProjectManifest(
  projectId: string,
  raw: string,
): Promise<ManifestValidationResult> {
  return unwrap(
    await backendApi.post<ManifestValidationResult>(`/projects/${projectId}/manifest/validate`, {
      raw,
    }),
    'Failed to validate manifest',
  );
}

export interface ProjectGitToken {
  push_token: string;
  /** Provider-selected HTTP Basic username (`x-access-token` for GitHub, `t` for Code Storage). */
  git_username: string;
  repo_id: string | null;
  repo_url: string | null;
}

/**
 * Mint a fresh scoped git push token for a *managed* project (so the CLI can
 * `kortix ship` without persisting credentials in git config). Throws (409)
 * for BYO projects — they push with the user's own git remote auth.
 */
export async function getProjectGitToken(projectId: string): Promise<ProjectGitToken> {
  return unwrap(
    await backendApi.post<ProjectGitToken>(`/projects/${projectId}/git-token`, {}),
    'Failed to mint git token',
  );
}

/** True when this project's repo is a Kortix-managed GitHub repo (invitable). */
export function isManagedGithubProject(project: {
  metadata?: Record<string, unknown> | null;
}): boolean {
  const git = (project.metadata as { git?: { provider?: string; managed?: boolean } } | undefined)
    ?.git;
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

/**
 * Load the compact, connection-aware catalog intended for interactive model
 * selectors. Unlike `getProjectLlmCatalog`, this does not transfer the complete
 * runtime models.dev projection used to configure OpenCode sandboxes.
 */
export async function getProjectModelPicker(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<ProjectLlmCatalogResponse>(`/projects/${projectId}/model-picker`, {
      showErrors: false,
      ...options,
    }),
  );
}

/** One provider row from the live, server-refreshed models.dev catalog. */
export interface ProjectLlmCatalogProvider {
  id: string;
  name: string;
  env?: string[];
  doc?: string | null;
  api?: string | null;
  npm?: string | null;
  models: Array<{ id: string; name: string; released: string | null }>;
}

export interface ProjectLlmCatalogProvidersResponse {
  source: string;
  fetched_at: string;
  provider_count: number;
  model_count: number;
  providers: ProjectLlmCatalogProvider[];
}

/**
 * The PROVIDER-level rows of the live runtime catalog — id/name/env/doc per
 * provider, the shape the connect modal (apps/web/src/lib/llm-providers.ts)
 * needs. Unlike `getProjectLlmCatalog`/`getProjectModelPicker`, works for
 * native (non-gateway) projects too — see the route's doc comment
 * (apps/api/src/projects/routes/r4.ts, `/llm-catalog/providers`).
 */
export async function getProjectLlmCatalogProviders(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<ProjectLlmCatalogProvidersResponse>(
      `/projects/${projectId}/llm-catalog/providers`,
      { showErrors: false, ...options },
    ),
  );
}

export async function createProject(input: ProjectInput) {
  return unwrap(await backendApi.post<KortixProject>('/projects', input));
}

export async function createProjectRepo(input: CreateProjectRepoInput) {
  return unwrap(await backendApi.post<KortixProject>('/projects/create-repo', input));
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

export interface ManagedGitStatus {
  configured: boolean;
  provider: string;
}

/**
 * Whether the managed-git "Create project" path (provisionProject/POST
 * /projects/provision) is usable on this server. Lets the create-project UI
 * pre-check and disable/annotate that option instead of letting the user hit
 * a 503 — self-host deployments with no MANAGED_GIT_* configured are the
 * primary case (the BYO-repo import path stays available regardless).
 * `showErrors: false` — a failure here is a soft "assume unavailable", not
 * something that should ever surface as a toast of its own.
 */
export async function getManagedGitStatus(): Promise<ManagedGitStatus> {
  try {
    return unwrap(
      await backendApi.get<ManagedGitStatus>('/projects/managed-git/status', {
        showErrors: false,
      }),
    );
  } catch {
    return { configured: false, provider: 'github' };
  }
}

export async function updateProject(projectId: string, input: Partial<ProjectInput>) {
  return unwrap(await backendApi.patch<KortixProject>(`/projects/${projectId}`, input));
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

/**
 * The durable provider-migration transition the API returns on the PATCH prepare
 * branch (a switch to a different, non-default enabled provider — e.g.
 * Daytona→Platinum) and that {@link getProjectSandboxProviderTransition} polls.
 * Distinguished from a plain project by `kind:'preparation'`. The switch does NOT
 * flip the active provider synchronously; the target image is built + verified
 * first, then activated, and the client polls until a terminal `status`.
 */
export interface PreparationView {
  kind: 'preparation';
  transition_id: string | null;
  project_id: string;
  /** ProviderTransitionStatus | 'noop' | 'cleared' — see the transition core. */
  status: string;
  source_provider: string | null;
  target_provider: string | null;
  active_provider: string | null;
  label: string;
  generation: number | null;
  snapshot_name: string | null;
  external_template_id: string | null;
  commit_sha: string | null;
  attempts: number;
  last_error: string | null;
  error_class: string | null;
  requested_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  immediate: boolean;
}

/**
 * The result of {@link updateProjectSandboxProvider}: EITHER the updated project
 * (a safe/immediate switch — null clear, the platform default, or the
 * already-active provider) tagged `kind:'project'`, OR a {@link PreparationView}
 * (the prepare branch) tagged `kind:'preparation'`. Both arrive under HTTP 200 —
 * branch on `kind`, never shape-sniff. A `kind:'preparation'` result must NOT be
 * written into the project cache; poll
 * {@link getProjectSandboxProviderTransition} until it settles.
 */
export type UpdateProjectSandboxProviderResult =
  | ({ kind: 'project' } & KortixProject)
  | PreparationView;

/** Set or clear the per-project sandbox-provider pin (Customize → Settings).
 *  Pass `null` to clear (follow the platform default/distribution). The value must
 *  be one of the project's `available_sandbox_providers`.
 *
 *  Returns a tagged union (see {@link UpdateProjectSandboxProviderResult}): a
 *  `kind:'project'` immediate result, or a `kind:'preparation'` transition the
 *  caller polls via {@link getProjectSandboxProviderTransition}. */
export async function updateProjectSandboxProvider(
  projectId: string,
  provider: SandboxProviderName | null,
): Promise<UpdateProjectSandboxProviderResult> {
  return unwrap(
    await backendApi.patch<UpdateProjectSandboxProviderResult>(
      `/projects/${projectId}/sandbox-provider`,
      { provider },
    ),
  );
}

/** PUBLIC provider-migration transition view served by the poll endpoint. Carries
 *  only status / providers / generation / timestamps / a user-safe error class +
 *  label — never internal build/lease detail. */
export interface SandboxProviderTransitionView {
  transition_id: string | null;
  project_id: string;
  status: string;
  source_provider: string | null;
  target_provider: string | null;
  generation: number | null;
  label: string;
  error_class: string | null;
  requested_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  immediate: boolean;
}

export interface SandboxProviderTransitionState {
  active_provider: string | null;
  latest: SandboxProviderTransitionView | null;
  history: SandboxProviderTransitionView[];
}

/** Poll the durable per-project sandbox-provider migration. After
 *  {@link updateProjectSandboxProvider} returns a `kind:'preparation'` result,
 *  poll this until `latest` reaches a terminal status (activated / failed /
 *  superseded / cancelled) — or `latest` is null (no live transition). */
export async function getProjectSandboxProviderTransition(
  projectId: string,
  options?: ApiClientOptions,
) {
  return unwrap(
    await backendApi.get<SandboxProviderTransitionState>(
      `/projects/${projectId}/sandbox-provider/transition`,
      { showErrors: false, ...options },
    ),
  );
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
  return unwrap(await backendApi.patch<KortixProject>(`/projects/${projectId}/warm-pool`, input));
}

export async function setProjectOnboardingComplete(projectId: string, completed: boolean) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/onboarding`, { completed }),
  );
}

export async function archiveProject(projectId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}`));
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
