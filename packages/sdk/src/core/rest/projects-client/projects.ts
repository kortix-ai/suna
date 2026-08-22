// Projects — project CRUD, detail, feature flags, warm pool, onboarding.

import { ApiError, type ApiClientOptions, backendApi } from '../../http/api-client';
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

/**
 * Stable ids for the platform's per-project feature flags (mirrors
 * `apps/api/src/feature-flags/registry.ts` and `FeatureFlagMapSchema` in
 * `@kortix/api-contract`).
 *
 * The union is hand-written on purpose: this package is framework-free AND
 * dependency-light, and importing `@kortix/api-contract` would drag zod into
 * every consumer's bundle. {@link FEATURE_FLAG_KEYS} is the runtime witness of
 * the same list, so other packages can assert the two have not drifted.
 */
export type FeatureFlagKey =
  | 'agent_tunnel'
  | 'marketplace'
  | 'connectors_api_discover'
  | 'agentmail_email'
  | 'teams'
  | 'voice'
  | 'llm_gateway'
  | 'review_center'
  | 'meta_agent'
  | 'apps'
  | 'monitors'
  | 'warm_sessions'
  | 'secrets_egress';

/**
 * Every {@link FeatureFlagKey}, at runtime. Kept in the same order as the
 * union above. Cross-package drift tests compare this against the API's
 * `FEATURE_FLAG_KEYS`.
 */
export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = [
  'agent_tunnel',
  'marketplace',
  'connectors_api_discover',
  'agentmail_email',
  'teams',
  'voice',
  'llm_gateway',
  'review_center',
  'meta_agent',
  'apps',
  'monitors',
  'warm_sessions',
  'secrets_egress',
] as const;

/**
 * How mature a flag is. This is a per-flag BADGE, not the name of the system:
 * the system is "Feature flags", and a flag can be `stable` and still ship
 * behind a switch.
 */
export type FeatureFlagStability = 'experimental' | 'beta' | 'stable';

/** One feature flag as described by the API catalog. */
export interface FeatureFlagView {
  key: FeatureFlagKey;
  name: string;
  description: string;
  stability: FeatureFlagStability;
  /** Platform supports it (operator env). When false the UI hides the toggle. */
  available: boolean;
  /** Effective per-project state (the switch position). */
  enabled: boolean;
  /** True when this project set an explicit choice (vs inheriting the default). */
  overridden: boolean;
}

/** @deprecated Renamed to {@link FeatureFlagKey}. Removed in the next major. */
export type ExperimentalFeatureKey = FeatureFlagKey;

/** @deprecated Renamed to {@link FeatureFlagView}. Removed in the next major. */
export type ExperimentalFeatureView = FeatureFlagView;

/** A project's named-glyph icon. `name` is a Phosphor identifier from the
 *  server's fixed catalogue; `color` is one of eight palette names. */
export interface ProjectGlyph {
  name: string;
  color: string;
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
  /** Effective on/off for each feature flag for THIS project. The field name is
   *  a stable wire detail — the system is called "Feature flags". */
  experimental?: Record<FeatureFlagKey, boolean>;
  /** Full feature-flag catalog (drives Customize → Feature flags).
   *  Self-describing so the UI never hard-codes the list. */
  experimental_features?: FeatureFlagView[];
  /** Effective per-project warm sandbox pool config (Customize → Sandbox). */
  warm_pool?: { enabled: boolean; size: number };
  /** Whether the warm pool feature is enabled platform-wide (gates the UI). */
  warm_pool_available?: boolean;
  /** Per-project sandbox-provider pin (Customize → Settings). null = follow the
   *  platform default/distribution. */
  default_sandbox_provider?: SandboxProviderName | null;
  /** Enabled sandbox providers the picker offers (ALLOWED ∩ has-API-key). */
  available_sandbox_providers?: SandboxProviderName[];
  /** Per-project emoji shown on the project card. Server-validated: exactly one
   *  emoji grapheme, or null. Stored in `metadata.icon`; surfaced top-level so
   *  clients never cast the metadata bag. */
  icon?: string | null;
  /** A named glyph + colour, the alternative to `icon`. At most one of the two
   *  is ever set — the API deletes the other whenever either is written.
   *  Stored in `metadata.icon_glyph`; surfaced top-level so callers do not read
   *  raw metadata. Server-validated against a fixed catalogue, or null. */
  icon_glyph?: ProjectGlyph | null;
}

export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  open_code_raw: string | null;
  /** Provider-neutral project default. The SDK derives this from legacy servers. */
  default_agent?: string | null;
  /** @deprecated Use `default_agent`. */
  open_code_default_agent: string | null;
  agent_discovery: 'opencode' | 'declarative';
  agents: Array<{
    name: string;
    path: string;
    description: string | null;
    mode: string | null;
    source?: 'opencode' | 'kortix.toml';
    enabled?: boolean;
    /** Agent-specific sandbox template. null or absent inherits the project default. */
    sandbox?: string | null;
    /** Per-agent governance from `kortix.yaml` `agents:` (read-only mirror).
     *  `'all'` = unscoped; a list = the allowlist; `[]` = none. Absent for
     *  OpenCode-discovered agents (not governed by `agents:`). */
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
  /**
   * Whether the project OFFERS this model — server-owned per-project
   * enablement, resolved by the API. Display-only: pickers hide a disabled
   * model, but the gateway still serves it if a caller names it outright.
   * Served by `/model-picker`; absent on the raw `/llm-catalog` (sandbox
   * config) path, where enablement doesn't apply.
   */
  enabled?: boolean;
}

export interface ProjectLlmCatalogResponse {
  models: Record<string, GatewayCatalogModel>;
  /**
   * The project's stored EXCEPTIONS to the default model set
   * (`wireModelId -> enabled`). Served by `/model-picker` so a client toggling
   * one model can PUT the merged map back. Read `GatewayCatalogModel.enabled`
   * for the RESOLVED answer — this is only the delta.
   */
  modelOverrides?: Record<string, boolean>;
  /**
   * True while the project has made no exceptions and is running on the pure
   * catalog default. What "reset to defaults" acts on; not derivable from the
   * `enabled` flags alone.
   */
  usingDefaults?: boolean;
  /**
   * The wire model `auto` resolves to for this project. It can never be turned
   * off (the PUT refuses it with 409 — disabling it would break every default
   * request), so surfaces with a per-model switch must render this one locked.
   */
  defaultModel?: string;
}

export interface ProjectInput {
  account_id?: string;
  name?: string;
  repo_url: string;
  default_branch?: string;
  manifest_path?: string;
  /**
   * The project's emoji icon. Nullable because `PATCH /projects/:id` reads
   * THREE states off this member and only the request body can tell them
   * apart — see {@link updateProject}:
   *
   * - omit the key   → the stored icon is left alone
   * - `null`         → the stored icon is removed
   * - `'🚀'`         → the stored icon is replaced
   *
   * An invalid value is dropped server-side; it never fails the update, and it
   * never removes the existing icon.
   */
  icon?: string | null;
  /**
   * The project's glyph icon. Nullable because `PATCH /projects/:id` reads
   * present-and-null differently from absent:
   *
   * - omit the key → the stored glyph is left alone
   * - `null`       → the stored glyph is removed
   * - an object    → the stored glyph is replaced, and the emoji `icon` cleared
   *
   * A malformed value is ignored and never removes the existing glyph.
   */
  icon_glyph?: ProjectGlyph | null;
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
  /** Optional emoji icon for the new project. Invalid values are dropped
   *  server-side; they never fail the create. */
  icon?: string;
  /** Optional glyph icon for the new project. Invalid values are dropped
   *  rather than failing the create. Wins over `icon` if both are given. */
  icon_glyph?: ProjectGlyph;
}

export interface ProvisionProjectInput {
  account_id?: string;
  name: string;
  /** Seed the managed repo with the Kortix starter so sessions can boot. */
  seed_starter?: boolean;
  /** Default branch for the newly-created managed repo. Omit to accept the
   *  server's own default (`apps/api/src/projects/routes/r1.ts`). */
  default_branch?: string;
  starter_template?: 'general-knowledge-worker' | 'minimal';
  marketplace_items?: string[];
  /** Clone a `registry:project` marketplace item instead of the blank
   *  starter — e.g. `"kortix-projects:support-agent-kit"`. Implies
   *  seed_starter and takes precedence over starter_template. */
  source_item_id?: string;
  /** Optional emoji icon for the new project. Invalid values are dropped
   *  server-side; they never fail the create. */
  icon?: string;
  /** Optional glyph icon for the new project. Invalid values are dropped
   *  rather than failing the create. Wins over `icon` if both are given. */
  icon_glyph?: ProjectGlyph;
  /**
   * Caller-supplied dedupe token. Provision mints a brand-new managed repo on
   * every call, so a retry after a lost response — a reload, a second tab, an
   * aborted request — otherwise creates a real duplicate project with its own
   * repo. Send the SAME key for every attempt at one logical create and the
   * server returns the project the first attempt made (201, same
   * `project_id`) instead of creating another.
   *
   * Scope is the account: the same key under a different account creates
   * normally. The key identifies the ATTEMPT, not the payload — it is not a
   * request fingerprint, so reusing one with a different `name` or
   * `starter_template` returns the FIRST project and ignores the new values.
   * Mint a fresh key per distinct create; creating a second project with the
   * same NAME and no key still works.
   *
   * Retry on `409` with `code: 'provision_in_flight'`. It means an earlier call
   * with this key is still running (or lost a write race) and its project is
   * not safe to hand back yet. Keep the SAME key when you retry.
   *
   * Format: 1–200 characters of `A–Z a–z 0–9 . _ : -`. A UUID per create
   * attempt is the intended shape. Omit it and the route behaves exactly as
   * before.
   */
  idempotency_key?: string;
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
  const detail = unwrap(
    await backendApi.get<ProjectDetail>(`/projects/${projectId}/detail`, {
      showErrors: false,
      ...options,
    }),
  );
  return {
    ...detail,
    config: {
      ...detail.config,
      default_agent: detail.config.default_agent ?? detail.config.open_code_default_agent ?? null,
    },
  };
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
export async function provisionProject(
  input: ProvisionProjectInput,
  options: ApiClientOptions = {},
) {
  return unwrap(
    await backendApi.post<KortixProject>(
      '/projects/provision',
      {
        seed_starter: true,
        ...input,
      },
      {
        timeout: 120_000,
        ...options,
      },
    ),
  );
}

/**
 * The phases `POST /projects/provision-stream` reports, in the order it
 * reports them. Mirrors `PROVISION_PHASES` in
 * `apps/api/src/projects/provision-core.ts` — a separate package, so a
 * separate declaration, but the two must stay byte-identical. A drift here
 * (a renamed or reordered phase on one side only) means the UI silently
 * stops advancing on whichever phase name no longer matches, with no error —
 * see the exhaustiveness test in `projects.test.ts` that pins this union
 * against the literal phase list.
 */
export type ProvisionPhase = 'validating' | 'creating_repository' | 'registering' | 'seeding';

/**
 * One frame of `POST /projects/provision-stream`'s SSE body.
 *
 * The `error` frame's `status` mirrors the HTTP status the equivalent
 * `/provision` response would have carried for the same failure — the route
 * (`apps/api/src/projects/routes/r1.ts`) writes `result.status` from the
 * shared `runProvision` core alongside `error`/`code`, exactly the fields
 * `provisionProjectStream` (below) copies onto the error it throws. Without
 * this, a host reading only `.status`/`.code` (as `apps/web`'s
 * `messageFor`/`isRetryableError` do) cannot tell a 400 from a 409 on this
 * transport, even though it can on the plain `provisionProject` path.
 */
export type ProvisionStreamEvent =
  | { type: 'phase'; phase: ProvisionPhase }
  | { type: 'done'; project: KortixProject }
  | { type: 'error'; error: string; code?: string; status?: number };

/**
 * Parse ONE SSE frame — the text between two `\n\n` boundaries — into a
 * `ProvisionStreamEvent`, or `null` if the frame carries no `data:` line.
 *
 * Line-by-line, not `frame.startsWith('data: ')` against the whole frame:
 * SSE permits `: comment` lines and an `event:` line ahead of `data:`, and
 * the wire contract here is data-only (no `event:` line) ONLY as an
 * implementation choice the server documents, not a protocol guarantee a
 * client should hard-fail without. A parser that rejects any frame that
 * isn't EXACTLY `data: <json>` breaks the moment a spec-legal frame shows up
 * that it wasn't exactly expecting. Per the SSE spec, multiple `data:` lines
 * in one frame are joined with `\n` before parsing.
 */
/** How much of an unparseable frame's payload to surface in the thrown error.
 *  Bounded hard: a frame can be arbitrarily large, and — in the wrong build,
 *  on the wrong route — could in principle carry something sensitive (a push
 *  token). Never include more than this, and never log the payload anywhere. */
const FRAME_PARSE_ERROR_EXCERPT_LENGTH = 200;

function parseProvisionStreamFrame(frame: string): ProvisionStreamEvent | null {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (dataLines.length === 0) return null;

  const payload = dataLines.join('\n');
  try {
    return JSON.parse(payload) as ProvisionStreamEvent;
  } catch (cause) {
    const excerpt =
      payload.length > FRAME_PARSE_ERROR_EXCERPT_LENGTH
        ? `${payload.slice(0, FRAME_PARSE_ERROR_EXCERPT_LENGTH)}…`
        : payload;
    // Named + attributed: a bare `SyntaxError: JSON Parse error: Expected
    // '}'` gives someone debugging a proxy that mangled one frame in
    // production nothing to go on — no mention of provisionProjectStream, no
    // mention that this came from an SSE frame, no sight of what the frame
    // actually contained.
    throw new Error(
      `provisionProjectStream: received an unparseable SSE frame (${excerpt})`,
      { cause },
    );
  }
}

/**
 * Create a managed-repo project, reporting which phase the server is in as
 * it happens.
 *
 * Same create as {@link provisionProject} — the server runs ONE shared
 * implementation (`runProvision` in `apps/api/src/projects/provision-core.ts`)
 * behind both `/projects/provision` and `/projects/provision-stream`. Use
 * this when a UI needs to show progress; use `provisionProject` for a plain
 * request/response.
 *
 * The stream always ends in a terminal `done` or `error` frame — the server
 * guarantees it (see the route's `finally`/catch in
 * `apps/api/src/projects/routes/r1.ts`). A stream that closes with NEITHER is
 * treated as a failure here too, never as an implicit success: resolving
 * with no project would hand the caller an undefined project id and route a
 * user to `/projects/undefined`.
 *
 * A pre-stream authorization denial (e.g. "Owner or admin role required")
 * arrives as a plain non-2xx JSON response, never as a `200` that then opens
 * an SSE body containing an `error` frame — this function rejects with that
 * response's message the same way it rejects an in-stream `error` event.
 * Both rejections are a real `ApiError` carrying `.status`/`.code`, not a
 * bare `Error` — see the `ProvisionStreamEvent` doc comment above for why
 * that match to `ApiError`'s shape matters.
 *
 * ## Streaming target matrix
 *
 * Requires `fetch` with a real `ReadableStream` response body:
 *
 * | Target                          | Streams? |
 * |----------------------------------|----------|
 * | Modern browsers (Safari 16.4+)   | yes |
 * | Node >= 18                       | yes |
 * | Bun                               | yes |
 * | Cloudflare Workers                | yes |
 * | **React Native / Expo**          | **NO** |
 *
 * **React Native is NOT supported.** RN's `fetch` has no `response.body` —
 * there is no way to read a stream incrementally on that runtime, full stop.
 * (This function decodes with plain `TextDecoder.decode()`, not
 * `TextDecoderStream`, so Hermes's missing `TextDecoderStream` is not what
 * blocks it here — the absent `response.body` alone is sufficient.) Callers
 * on RN must use `provisionProject` instead (single request/response, no
 * progress reporting).
 */
export async function provisionProjectStream(
  input: ProvisionProjectInput,
  onEvent: (event: ProvisionStreamEvent) => void,
  options: ApiClientOptions = {},
): Promise<KortixProject> {
  const response = await backendApi.postStream(
    '/projects/provision-stream',
    { seed_starter: true, ...input },
    options,
  );

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    // A REAL `ApiError`, not a bare `Error` — see the `ProvisionStreamEvent`
    // doc comment above. `apps/web`'s `messageFor`/`isRetryableError` read
    // `.status`/`.code` off whatever `provisionProject`/`provisionProjectStream`
    // throw; without this they saw `undefined` for both on this transport.
    throw new ApiError(body?.error || `Provision failed: HTTP ${response.status}`, {
      status: response.status,
      code: body?.code,
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Provision stream is unavailable on this runtime (no response body)');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let settled: KortixProject | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const event = parseProvisionStreamFrame(frame);
        if (!event) continue;
        onEvent(event);
        // Same `ApiError` shape as the pre-stream-denial branch above, so a
        // host classifying create failures gets identical `.status`/`.code`
        // whichever branch fired.
        if (event.type === 'error') {
          throw new ApiError(event.error, { status: event.status, code: event.code });
        }
        if (event.type === 'done') settled = event.project;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  // A stream that closes without a terminal event is a failure, not a
  // success. Resolving here would hand the caller an undefined project id
  // and route a user to `/projects/undefined`.
  if (!settled) throw new Error('Provision stream ended without a result');
  return settled;
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

/**
 * Patch a project's editable fields. Only the members present in `input` are
 * touched — this is a real PATCH, not a replace.
 *
 * `icon` is the one member where present-and-null differs from absent: pass
 * `null` to REMOVE the project's emoji, omit the key to leave it as it is.
 * Everything else ignores an empty value.
 */
export async function updateProject(projectId: string, input: Partial<ProjectInput>) {
  return unwrap(await backendApi.patch<KortixProject>(`/projects/${projectId}`, input));
}

/**
 * Toggle a feature flag for a project (Customize → Feature flags). Pass
 * `enabled: null` to clear the override and fall back to the operator default.
 *
 * Hits the CANONICAL `PATCH /projects/:id/features` route.
 */
export async function updateFeatureFlag(
  projectId: string,
  feature: FeatureFlagKey,
  enabled: boolean | null,
) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/features`, {
      feature,
      enabled,
    }),
  );
}

/**
 * @deprecated Renamed to {@link updateFeatureFlag}. Removed in the next major.
 *
 * Deliberately NOT re-pointed at the canonical `/features` route: this alias
 * exists for consumers pinned to an older deployed API that only serves
 * `/projects/:id/experimental`. Changing its wire path would break them.
 */
export async function updateExperimentalFeature(
  projectId: string,
  feature: FeatureFlagKey,
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

export async function setProjectOnboardingComplete(projectId: string, completed: boolean) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/onboarding`, { completed }),
  );
}

/** Use case the account picked during guided project onboarding. */
export type OnboardingUseCase =
  | 'sales'
  | 'support'
  | 'marketing'
  | 'engineering'
  | 'finance_ops'
  | 'hr_recruiting'
  | 'other';

/** Company size buckets. Mirrors the demo-qualifier scale so a user who both
 *  onboards and books a demo is never offered two different scales. */
export type OnboardingCompanySize = '1-10' | '11-50' | '51-200' | '201-1000' | '1000+';

/** Every field optional — onboarding saves each answer as it is given, so a
 *  partial profile is the normal case, not an error case. */
export interface OnboardingProfile {
  use_case?: OnboardingUseCase;
  company_domain?: string;
  company_size?: OnboardingCompanySize;
}

/**
 * Persist guided-onboarding answers into `projects.metadata.onboarding`.
 *
 * Deliberately separate from {@link setProjectOnboardingComplete}: completion is
 * a lifecycle flag at the top level of `metadata`, the profile is a nested
 * object, and the two are written by different steps at different times. Sending
 * `completed` from a survey save would end onboarding the moment the user
 * answered the first question.
 */
export async function setProjectOnboardingProfile(projectId: string, profile: OnboardingProfile) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/projects/${projectId}/onboarding`, { profile }),
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
