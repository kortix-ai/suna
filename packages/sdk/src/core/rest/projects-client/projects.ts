// Projects — project CRUD, detail, feature flags, onboarding.

import type { CatalogModel } from '@kortix/llm-catalog';
import { readProvisionStream } from './provision-stream';
import type { ManifestIssue } from './change-request-recovery';
import type { ManifestSpace } from './manifest-spaces';
import { ApiError, type ApiClientOptions, backendApi } from '../../http/api-client';
import { retiredEndpointError } from '../../http/api/errors';
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
 *
 * `review_center`, `agent_tunnel`, `session_transcript_history`, `teams`,
 * `config_releases`, `apps`, `llm_gateway`, `pi_harness`, `genui`, `agentmail_email`, `connectors_v2` and `connectors_api_discover` are deprecated. `agent_tunnel` graduated like
 * `review_center` below: a paired computer is a connector account and needs no
 * flag. So did `session_transcript_history`: every session saves its
 * transcript and shows it while its computer is off. And `teams`: every
 * project can connect Microsoft Teams. And `config_releases`: every session
 * runs its base branch's config release. And `apps`: Apps is generally
 * available — every project can create and deploy Apps. And `llm_gateway`:
 * the LLM gateway is the only model path for every project. And `pi_harness`:
 * every new session runs pi. And `genui`: generative UI is on for every
 * project, and every session lists the kortix-genui system skill.
 * And `agentmail_email`: every project can
 * connect an email inbox. And `connectors_v2` with `connectors_api_discover`:
 * the Kortix connectors catalog is the only connectors path; the API sends a
 * constant `true` for both.
 *
 * `review_center` is deprecated. Review Center graduated out of the flag
 * system: it is on for every project, and the API no longer lists, resolves,
 * or accepts the key. It stays in this union so code written against the older
 * union still compiles, and `useFeatureFlag(id, 'review_center')` reports
 * `enabled: true`. It is absent from {@link FEATURE_FLAG_KEYS} and from
 * `KortixProject.experimental`. Removed in the next major.
 */
export type FeatureFlagKey =
  /** @deprecated Graduated — computers need no flag (the platform's `TUNNEL_ENABLED` is the only gate). Removed in the next major. */
  | 'agent_tunnel'
  | 'marketplace'
  /** @deprecated Graduated — integrations.sh is part of the one Kortix catalog. Removed in the next major. */
  | 'connectors_api_discover'
  /** @deprecated Graduated — every project can connect an email inbox. Removed in the next major. */
  | 'agentmail_email'
  /** @deprecated Graduated — every project can connect Microsoft Teams. Removed in the next major. */
  | 'teams'
  /** @deprecated Graduated — the LLM gateway is the only model path for every project. Removed in the next major. */
  | 'llm_gateway'
  /** @deprecated Graduated — Review Center is on for every project. Removed in the next major. */
  | 'review_center'
  /** @deprecated Graduated — My Kortix follows kortix.yaml `builtin_agents.my_kortix` alone. The API sends `true` for every project. Removed in the next major. */
  | 'meta_agent'
  /** @deprecated Graduated — Apps is on for every project. Removed in the next major. */
  | 'apps'
  /** @deprecated Withdrawn — the monitor box was removed; an App with a schedule or a `type: app` trigger replaces it. The API no longer lists, resolves, or accepts it. Removed in the next major. */
  | 'monitors'
  | 'reminders'
  /** @deprecated Withdrawn — warm sessions were removed; a session boots on its own. The API sends `false` for every project. Removed in the next major. */
  | 'warm_sessions'
  | 'secrets_egress'
  /** @deprecated Withdrawn — the pi worker split left the product; pi runs in the session sandbox. The API no longer lists, resolves, or accepts it. Removed in the next major. */
  | 'pi_worker'
  /** @deprecated Graduated — every session saves its transcript. Removed in the next major. */
  | 'session_transcript_history'
  | 'pooled_provider_secrets'
  /** @deprecated Graduated — every new session runs pi; OpenCode is sunset. The API sends `true` for every project. Removed in the next major. */
  | 'pi_harness'
  /** @deprecated Graduated — generative UI is on for every project. The API sends `true` for every project. Removed in the next major. */
  | 'genui'
  /** @deprecated Graduated — every session runs its base branch's config release. Removed in the next major. */
  | 'config_releases'
  /** @deprecated Graduated — every governed agent authorizes as itself; there is no switch. Removed in the next major. */
  | 'agent_principal'
  | 'us_region'
  | 'event_triggers'
  /** @deprecated Graduated 2026-11-06 — notifications (the inbox, push, session watch, alerts, per-kind notification settings) are on for every project. The API sends `true` for every project, so `useFeatureFlag(id, 'notification_center')` reports `enabled: true`. Removed in the next major. */
  | 'notification_center'
  /** @deprecated Graduated 2026-11-02 — every project has a Drive. The API sends `true` wherever the platform stores a Drive (Platinum). Removed in the next major. */
  | 'volumes'
  /** @deprecated Withdrawn — stateless sessions left the product. The API no longer lists, resolves, or accepts it. Removed in the next major. */
  | 'stateless_sessions'
  /** @deprecated Graduated 2026-11-02 with `volumes` — every project has a Drive. The API sends `true` wherever the platform stores a Drive (Platinum), so `useFeatureFlag(id, 'drives')` reads Drive availability. Removed in the next major. */
  | 'drives'
  /** @deprecated Withdrawn with `stateless_sessions`. The API no longer lists or resolves it. Removed in the next major. */
  | 'ephemeral_sandboxes'
  /** Not a flag since P8.2 (2026-10-22): the session log is every session's saved history, and the API sends `true` for every project. Absent from {@link FEATURE_FLAG_KEYS}. */
  | 'session_log'
  /** @deprecated Graduated 2026-11-05 — every box restores the conversation from the session log when its own copy is missing or behind. The API sends `true` for every project. Removed in the next major. */
  | 'session_log_restore'
  /** @deprecated Graduated — the Kortix connectors catalog is the only connectors path. Removed in the next major. */
  | 'connectors_v2'
  /** Chat: a Slack-style chat with Kortix. Every message is a thread, Kortix's newest reply shows under it, Kortix can start threads, and spaces are shared with people. Experimental, off by default. */
  | 'chat'
  /** @deprecated Withdrawn — merged into `chat` (2026-11). The API sends it equal to `chat` and writes `chat` for it; it is not in the catalog. Read `chat`. Removed in the next major. */
  | 'project_channels'
  /** @deprecated Withdrawn — Rooms were removed (2026-11). The API no longer lists, resolves, or accepts it. Removed in the next major. */
  | 'agent_rooms'
  /** Shared Drives: an admin makes a Drive and adds agents to it. Off by default: people have only My files. */
  | 'shared_drives'
  | 'goals'
  | 'workspace_volume'
  /** @deprecated Graduated 2026-11-06 — every project has Artifacts wherever the platform stores Files (Platinum). The API sends `true` there, so `useFeatureFlag(id, 'artifacts')` reads Artifacts availability. Removed in the next major. */
  | 'artifacts'
  /** @deprecated Withdrawn 2026-11-06 — artifact comments, live presence, co-editing and the activity feed were removed. The API sends `false`. Removed in the next major. */
  | 'artifact_comments'
  /** The email channel: a Resend inbox that starts and continues sessions. Experimental, off by default. */
  | 'email_channel'
  /** Session groups: named folders of the project's sessions that every member shares. Experimental, off by default. */
  | 'session_groups'
  /** Kortix in Chrome: a session drives its owner's own Chrome through the extension. Experimental; on where the platform offers it. */
  | 'chrome'
  /** Agent teams: a lead session with named teammates and a shared task list. Experimental, off by default. */
  | 'agent_teams'
  /** Voice calls: talk with the session's agent from the session page, with screen share. Off by default. */
  | 'voice_call'
  /** Chat input: one composer control for the agent and every session override (model, effort, secrets, provider keys, sandbox). Experimental, off by default. */
  | 'chat_input'
  /** Talk-only threads: with `chat` on, a new space thread's agent only talks and hands the work to one hidden My Kortix session. Experimental, off by default. */
  | 'chat_front'
  /** Proactive spaces: with `chat` on, a space's watcher reads what happens in the space and posts, starts a thread or asks only when it matters. Experimental, off by default. */
  | 'spaces_proactive'
  /** @deprecated Withdrawn — agents messaging people left the product. The API no longer lists, resolves, or accepts it. Removed in the next major. */
  | 'human_messaging';

/** The keys of {@link FeatureFlagKey} that are no flag: the API never sends them, or (`llm_gateway`, `session_log`, `session_log_restore`, `pi_harness`, `genui`, `meta_agent`, `notification_center`) sends a constant `true`, or (`volumes`, `drives`, `artifacts`) sends whether the platform stores a Drive, or (`artifact_comments`) sends a constant `false`. */
type GraduatedFeatureFlagKey =
  | 'agent_tunnel'
  | 'teams'
  | 'review_center'
  | 'session_transcript_history'
  | 'agent_principal'
  | 'human_messaging'
  | 'project_channels'
  | 'agent_rooms'
  | 'pi_worker'
  | 'config_releases'
  | 'apps'
  | 'llm_gateway'
  | 'stateless_sessions'
  | 'ephemeral_sandboxes'
  | 'session_log'
  | 'session_log_restore'
  | 'pi_harness'
  | 'genui'
  | 'agentmail_email'
  | 'monitors'
  | 'connectors_v2'
  | 'connectors_api_discover'
  | 'meta_agent'
  | 'warm_sessions'
  | 'volumes'
  | 'drives'
  | 'notification_center'
  | 'artifacts'
  | 'artifact_comments';
/** The keys `KortixProject.experimental` carries on every response. */
type ServedFeatureFlagKey = Exclude<FeatureFlagKey, GraduatedFeatureFlagKey>;

/**
 * Every {@link FeatureFlagKey} the API serves, at runtime. Kept in the same
 * order as the union above, minus deprecated graduated keys. Cross-package
 * drift tests compare this against the API's `FEATURE_FLAG_KEYS`.
 */
export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = [
  'marketplace',
  'reminders',
  'secrets_egress',
  'pooled_provider_secrets',
  'us_region',
  'event_triggers',
  'chat',
  'shared_drives',
  'goals',
  'workspace_volume',
  'email_channel',
  'session_groups',
  'chrome',
  'agent_teams',
  'voice_call',
  'chat_input',
  'chat_front',
  'spaces_proactive',
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
  /**
   * True for an internal-only flag (`workspace_volume`). The
   * catalog lists one only while it is on, so agents and people can see it.
   * Only a Kortix platform operator can change it: `PATCH /features` answers
   * `403` with `feature_operator_only`. Absent on servers older than this field.
   */
  operator_only?: boolean;
  /** Work in progress: not recommended yet. Absent on servers older than this field. */
  wip?: boolean;
  /**
   * Always `project`: every flag is set per project. A server from
   * 2026-10-12 sent `organization` for `volumes` and the withdrawn `stateless_sessions`.
   * Absent on servers older than this field.
   */
  scope?: 'project' | 'organization';
}

/** @deprecated Renamed to {@link FeatureFlagKey}. Removed in the next major. */
export type ExperimentalFeatureKey = FeatureFlagKey;

/** @deprecated Renamed to {@link FeatureFlagView}. Removed in the next major. */
export type ExperimentalFeatureView = FeatureFlagView;

/** A project's named-glyph icon. `name` is a Phosphor identifier from the
 *  server's fixed catalogue; `color` is one of eight palette names.
 *
 * @deprecated Use `WorkspaceGlyph`. Kept permanently.
 */
export interface ProjectGlyph {
  name: string;
  color: string;
}

/** The workspace name of {@link ProjectGlyph}: the same type. */
export type WorkspaceGlyph = ProjectGlyph;

/** @deprecated Use `KortixWorkspace`. Kept permanently. */
export interface KortixProject {
  project_id: string;
  /**
   * The workspace id: the same value as `project_id`. Sent by servers that
   * know workspaces; read `project_id` to support older ones.
   */
  workspace_id?: string;
  account_id: string;
  name: string;
  repo_url: string;
  /** The git origin a client clones and pushes: the Kortix git proxy when it
   *  is enabled, else `repo_url`. Absent from APIs older than this field. */
  git_origin_url?: string;
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
   *  a stable wire detail — the system is called "Feature flags". Deprecated
   *  graduated keys (`review_center`, `agent_tunnel`, …) are absent from the
   *  wire, so they are optional here. */
  experimental?: Record<ServedFeatureFlagKey, boolean> &
    Partial<Record<GraduatedFeatureFlagKey, boolean>>;
  /** Full feature-flag catalog (drives Customize → Feature flags).
   *  Self-describing so the UI never hard-codes the list. */
  experimental_features?: FeatureFlagView[];
  /** @deprecated The API no longer sends it. Removed in the next major. */
  warm_pool?: { enabled: boolean; size: number };
  /** @deprecated The API no longer sends it. Removed in the next major. */
  warm_pool_available?: boolean;
  /** Per-project sandbox-provider pin (Customize → Settings). null = follow the
   *  platform default/distribution. */
  default_sandbox_provider?: SandboxProviderName | null;
  /** Per-project default reasoning effort (a models.dev effort label such as
   *  `low`/`high`/`xhigh`), or null for automatic. Delivery injects it as the
   *  prompt's `variant` whenever the prompt carries none. */
  default_reasoning_effort?: string | null;
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
  /** The project's page in the web app. Absent from APIs older than this field. */
  dashboard_url?: string;
}

/** The workspace name of {@link KortixProject}: the same type. */
export type KortixWorkspace = KortixProject;

/** @deprecated Use `WorkspaceConfigSummary`. Kept permanently. */
export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  /** kortix.yaml problems for this project. Absent from an API released before the one-schema manifest. */
  manifest_health?: ProjectManifestHealth;
  /** @deprecated The API no longer sends it (an older API sends `null`). Removed in the next major. */
  open_code_raw?: string | null;
  /** The project's default agent (`kortix.yaml` `default_agent`), or null. */
  default_agent?: string | null;
  /** @deprecated The API no longer sends it; read `default_agent`. Removed in the next major. */
  open_code_default_agent?: string | null;
  /** Which built-in agents the project runs (`builtin_agents` in kortix.yaml;
   *  `true` = on, absent = off). `my_kortix` is My Kortix, the agent named `mykortix`.
   *  Absent from an older API. */
  builtin_agents?: { my_kortix: boolean };
  /**
   * Where `agents` comes from. The API sends `declarative` (the agents
   * `kortix.yaml` declares) for every project; a response filtered by the
   * caller's `project.agent.read` access sends `null`.
   * `opencode` is `@deprecated`: no API sends it. It stays in the union until the next major.
   */
  agent_discovery: 'declarative' | 'opencode';
  agents: Array<{
    name: string;
    path: string;
    description: string | null;
    mode: string | null;
    /** Internal automation remains registered but is not offered by agent pickers. */
    hidden?: boolean;
    /** The agent's `model:` frontmatter (`provider/model`); absent on older
     *  servers, null when it follows the project default. */
    model?: string | null;
    /** The server sends `kortix.yaml`. `opencode` and `kortix.toml` are never sent; they stay
     *  in the union until the next major. */
    source?: 'opencode' | 'kortix.yaml' | 'kortix.toml';
    enabled?: boolean;
    /** True for a platform-owned agent (SUNA — the coordinator) that the API
     *  injects, not one declared in `kortix.yaml`. Its configuration is fixed:
     *  hosts render it read-only and never open the agent editor for it.
     *  Absent/false = an ordinary editable project agent. */
    platform?: boolean;
    /** Agent-specific sandbox template. null or absent inherits the project default. */
    sandbox?: string | null;
    /** The space from `kortix.yaml` `agents.<name>.space`. Grouping only.
     *  null/absent is Project-wide (see `groupBySpace`). */
    space?: string | null;
    /** Per-agent governance from `kortix.yaml` `agents:` (read-only mirror).
     *  `'all'` = unscoped; a list = the allowlist; `[]` = none. Absent when
     *  `agents:` does not govern the agent. */
    scope?: {
      env: string[] | 'all';
      connectors: string[] | 'all';
      /** Kortix permissions (`project.*` actions). Absent on servers released
       *  before 2026-09-22 — fall back to `kortix_cli`. */
      kortix_permissions?: string[] | 'all';
      /** @deprecated Renamed to `kortix_permissions` (same value). Removed in the next major. */
      kortix_cli: string[] | 'all';
      /** Kortix Apps (by slug) the agent may open when restricted/private.
       *  `[]` = none. Absent on servers released before 2026-09-22 (= none). */
      apps?: string[] | 'all';
    };
  }>;
  skills: Array<{ name: string; path: string; description: string | null }>;
  commands: Array<{ name: string; path: string; description: string | null }>;
  env: { required: string[]; optional: string[] };
  /** The spaces from `kortix.yaml` top-level `spaces:`. Absent on older
   *  servers. `listSpaces(config)` adds the ones agents name. */
  spaces?: ManifestSpace[];
}

/** The workspace name of {@link ProjectConfigSummary}: the same type. */
export type WorkspaceConfigSummary = ProjectConfigSummary;

/**
 * What the server found in the project's `kortix.yaml`. `ok`: no issues.
 * `issues`: one or more; a running project still applies the valid rest, and
 * an agent or trigger with an error is off. `missing`: no manifest, built-in
 * agents only. `issues` lists errors first, at most 50.
 *
 * @deprecated Use `WorkspaceManifestHealth`. Kept permanently.
 */
export interface ProjectManifestHealth {
  /** Repository path of the manifest. null when none was read. */
  path: string | null;
  state: 'ok' | 'issues' | 'missing' | 'unreadable' | 'restricted' | 'repository_disconnected';
  errors: number;
  warnings: number;
  issues: ManifestIssue[];
}

/** The workspace name of {@link ProjectManifestHealth}: the same type. */
export type WorkspaceManifestHealth = ProjectManifestHealth;

/** @deprecated Use `WorkspaceDetail`. Kept permanently. */
export interface ProjectDetail {
  project: KortixProject;
  git_connection?: ProjectGitConnection | null;
  config: ProjectConfigSummary;
  /**
   * @deprecated Use `listProjectFiles(projectId, { path })`. The number of
   * repository files for a caller with `project.file.read`, else `0`. Removed
   * in the next major.
   */
  file_count: number;
  /**
   * @deprecated Use `listProjectFiles(projectId, { path })` for the files of
   * one folder. This list holds only the first 300 paths of the repository,
   * so on a large repository it misses files. Removed in the next major.
   */
  files: ProjectFileEntry[];
}

/** The workspace name of {@link ProjectDetail}: the same type. */
export type WorkspaceDetail = ProjectDetail;

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
   * synthetic `kortix` runtime provider, so this is the ONLY reliable way to
   * group/label a model by who actually serves it — Bedrock ids are
   * dot-namespaced (`us.anthropic.claude-opus-4-8`), so the legacy
   * split-on-slash heuristic cannot recover it.
   */
  provider?: string;
  /** The real provider's display name ("OpenCode Go"). Absent on managed models. */
  provider_name?: string;
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

/**
 * The Claude subscription models `/model-picker` lists apart from the gateway's
 * (`claude-agent/<id>`): they run through Claude Code on the caller's own Claude
 * plan. `connected` is whether the caller signed in to Claude.
 */
export interface ClaudeSubscriptionPickerGroup {
  providerId: string;
  name: string;
  connected: boolean;
  models: Array<{
    /** `claude-agent/<id>`. */
    id: string;
    name: string;
    description: string;
    limit: { context: number; output: number };
    efforts: string[];
    requires: 'claude_subscription';
    connected: boolean;
    /** The project's on/off switch for the model (Models tab). Absent from an older API: on. */
    enabled?: boolean;
  }>;
}

/** @deprecated Use `WorkspaceLlmCatalogResponse`. Kept permanently. */
export interface ProjectLlmCatalogResponse {
  models: Record<string, GatewayCatalogModel>;
  /** Absent from an API without Claude subscription models. */
  claudeSubscription?: ClaudeSubscriptionPickerGroup;
  /** Kortix's platform fee on managed model usage, in percent of each model's `cost`. */
  platformFeePercent?: number;
  /**
   * @deprecated The API no longer sends this. Kortix Platinum inference serves every
   * managed model at one price, which is the model's `cost`. Removed in the next major.
   */
  managedPricingRoutes?: Record<string, Array<{
    route: string;
    role: 'preferred' | 'eligible';
    input: number;
    cacheRead: number;
    output: number;
  }>>;
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

/** The workspace name of {@link ProjectLlmCatalogResponse}: the same type. */
export type WorkspaceLlmCatalogResponse = ProjectLlmCatalogResponse;

/** @deprecated Use `WorkspaceInput`. Kept permanently. */
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

/** The workspace name of {@link ProjectInput}: the same type. */
export type WorkspaceInput = ProjectInput;

/** @deprecated Use `CreateWorkspaceRepoInput`. Kept permanently. */
export interface CreateProjectRepoInput {
  account_id?: string;
  /**
   * The GitHub REPOSITORY name. Charset-validated server-side against
   * `/^[a-zA-Z0-9._-]+$/` — no spaces. A workspace name typed by a person
   * usually has to be slugified before it can go here; `project_name` below is
   * where the typed name belongs.
   */
  name: string;
  /**
   * The Kortix WORKSPACE name, when it differs from the repository name.
   * Omitted, the server derives one from the created repo's full name
   * (`deriveProjectName`), so "Ana's agents" would land as "Ana-s-agents".
   */
  project_name?: string;
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

/** The workspace name of {@link CreateProjectRepoInput}: the same type. */
export type CreateWorkspaceRepoInput = CreateProjectRepoInput;

/** @deprecated Use `ProvisionWorkspaceInput`. Kept permanently. */
export interface ProvisionProjectInput {
  account_id?: string;
  name: string;
  /** Seed the managed repo with the Kortix starter so sessions can boot. */
  seed_starter?: boolean;
  /** Default branch for the newly-created managed repo. Omit to accept the
   *  server's own default (`apps/api/src/projects/routes/projects.ts`). */
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

/** The workspace name of {@link ProvisionProjectInput}: the same type. */
export type ProvisionWorkspaceInput = ProvisionProjectInput;

export interface RepoCollaboratorInvite {
  username: string;
  permission: string;
  /** Pending-invitation URL to accept on GitHub, or null if already a collaborator. */
  invitationUrl: string | null;
  alreadyCollaborator: boolean;
}

/**
 * @deprecated Use `listWorkspaces`: every workspace of the caller, across accounts. This lists one account's projects. Kept permanently.
 */
export async function listProjects() {
  return unwrap(await backendApi.get<KortixProject[]>('/projects'));
}

export async function listWorkspacesForAccount(accountId?: string) {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(await backendApi.get<KortixProject[]>(`/projects${query}`));
}

/** @deprecated Use `listWorkspacesForAccount`. Kept permanently. */
export const listProjectsForAccount = listWorkspacesForAccount;

/**
 * @deprecated Use `getWorkspace` (the same record plus the role, the state and the settings block). Kept permanently.
 */
export async function getProject(projectId: string, options?: ApiClientOptions) {
  return unwrap(await backendApi.get<KortixProject>(`/workspaces/${projectId}`, options));
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
    await backendApi.post<RepoCollaboratorInvite>(`/workspaces/${projectId}/git/collaborators`, {
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
 * Validate a `kortix.yaml` manifest's raw text server-side — the same
 * schema the CLI (`kortix ship` pre-flight / `kortix validate`) and the CR-merge
 * gate exercise. Always resolves (never throws on an invalid manifest) — the
 * verdict is in the body.
 */
export async function validateWorkspaceManifest(
  projectId: string,
  raw: string,
): Promise<ManifestValidationResult> {
  return unwrap(
    await backendApi.post<ManifestValidationResult>(`/workspaces/${projectId}/manifest/validate`, {
      raw,
    }),
    'Failed to validate manifest',
  );
}

/** @deprecated Use `validateWorkspaceManifest`. Kept permanently. */
export const validateProjectManifest = validateWorkspaceManifest;

/** @deprecated Use `WorkspaceGitToken`. Kept permanently. */
export interface ProjectGitToken {
  push_token: string;
  /** Provider-selected HTTP Basic username (`x-access-token` for GitHub, `t` for Code Storage). */
  git_username: string;
  repo_id: string | null;
  repo_url: string | null;
}

/** The workspace name of {@link ProjectGitToken}: the same type. */
export type WorkspaceGitToken = ProjectGitToken;

/**
 * Mint a fresh scoped git push token for a *managed* project (so the CLI can
 * `kortix ship` without persisting credentials in git config). Throws (409)
 * for BYO projects — they push with the user's own git remote auth.
 */
export async function getWorkspaceGitToken(projectId: string): Promise<ProjectGitToken> {
  return unwrap(
    await backendApi.post<ProjectGitToken>(`/workspaces/${projectId}/git-token`, {}),
    'Failed to mint git token',
  );
}

/** @deprecated Use `getWorkspaceGitToken`. Kept permanently. */
export const getProjectGitToken = getWorkspaceGitToken;

/** True when this project's repo is a Kortix-managed GitHub repo (invitable). */
export function isManagedGithubWorkspace(project: {
  metadata?: Record<string, unknown> | null;
}): boolean {
  const git = (project.metadata as { git?: { provider?: string; managed?: boolean } } | undefined)
    ?.git;
  return git?.provider === 'github' && git?.managed === true;
}

/** @deprecated Use `isManagedGithubWorkspace`. Kept permanently. */
export const isManagedGithubProject = isManagedGithubWorkspace;

export async function getWorkspaceDetail(projectId: string, options?: ApiClientOptions) {
  const detail = unwrap(
    await backendApi.get<ProjectDetail>(`/workspaces/${projectId}/detail`, {
      showErrors: false,
      ...options,
    }),
  );
  return {
    ...detail,
    config: {
      ...detail.config,
      default_agent: detail.config.default_agent ?? null,
    },
  };
}

/** @deprecated Use `getWorkspaceDetail`. Kept permanently. */
export const getProjectDetail = getWorkspaceDetail;

export async function getWorkspaceLlmCatalog(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<ProjectLlmCatalogResponse>(`/workspaces/${projectId}/llm-catalog`, {
      showErrors: false,
      ...options,
    }),
  );
}

/** @deprecated Use `getWorkspaceLlmCatalog`. Kept permanently. */
export const getProjectLlmCatalog = getWorkspaceLlmCatalog;

/**
 * Load the compact, connection-aware catalog intended for interactive model
 * selectors. Unlike `getProjectLlmCatalog`, this does not transfer the complete
 * runtime models.dev projection used to configure sandboxes.
 */
export async function getWorkspaceModelPicker(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<ProjectLlmCatalogResponse>(`/workspaces/${projectId}/model-picker`, {
      showErrors: false,
      ...options,
    }),
  );
}

/** @deprecated Use `getWorkspaceModelPicker`. Kept permanently. */
export const getProjectModelPicker = getWorkspaceModelPicker;

/**
 * One MODEL row from the live catalog — the route serves the full
 * `@kortix/llm-catalog` `CatalogModel` shape verbatim
 * (runtimeModelCatalog.snapshot()), so the wire type IS that shared type:
 * a hand-rolled twin here is exactly the drift the catalog package exists to
 * prevent.
 *
 * @deprecated Use `WorkspaceLlmCatalogProviderModel`. Kept permanently.
 */
export type ProjectLlmCatalogProviderModel = CatalogModel;

/** The workspace name of {@link ProjectLlmCatalogProviderModel}: the same type. */
export type WorkspaceLlmCatalogProviderModel = ProjectLlmCatalogProviderModel;

/**
 * One provider row from the live, server-refreshed models.dev catalog.
 *
 * @deprecated Use `WorkspaceLlmCatalogProvider`. Kept permanently.
 */
export interface ProjectLlmCatalogProvider {
  id: string;
  name: string;
  env?: string[];
  doc?: string | null;
  api?: string | null;
  npm?: string | null;
  models: Array<ProjectLlmCatalogProviderModel>;
}

/** The workspace name of {@link ProjectLlmCatalogProvider}: the same type. */
export type WorkspaceLlmCatalogProvider = ProjectLlmCatalogProvider;

/** @deprecated Use `WorkspaceLlmCatalogProvidersResponse`. Kept permanently. */
export interface ProjectLlmCatalogProvidersResponse {
  source: string;
  fetched_at: string;
  provider_count: number;
  model_count: number;
  providers: ProjectLlmCatalogProvider[];
}

/** The workspace name of {@link ProjectLlmCatalogProvidersResponse}: the same type. */
export type WorkspaceLlmCatalogProvidersResponse = ProjectLlmCatalogProvidersResponse;

/**
 * The PROVIDER-level rows of the live runtime catalog — id/name/env/doc per
 * provider, the shape the connect modal (apps/web/src/lib/llm-providers.ts)
 * needs. See the route's doc comment (apps/api/src/projects/routes/models.ts,
 * `/llm-catalog/providers`).
 */
export async function getWorkspaceLlmCatalogProviders(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<ProjectLlmCatalogProvidersResponse>(
      `/workspaces/${projectId}/llm-catalog/providers`,
      { showErrors: false, ...options },
    ),
  );
}

/** @deprecated Use `getWorkspaceLlmCatalogProviders`. Kept permanently. */
export const getProjectLlmCatalogProviders = getWorkspaceLlmCatalogProviders;

/**
 * @deprecated Use `linkRepository` (`POST /v1/workspaces/link-repository`) to import a repository, or `createWorkspace` for a new workspace. Kept permanently.
 */
export async function createProject(input: ProjectInput) {
  return unwrap(await backendApi.post<KortixProject>('/projects', input));
}

/**
 * `showErrors: false`: `/new` renders this failure inline, with its own wording
 * and its own retry. The global handler toasting it as well produced two
 * different explanations of one failure — prod showed GitHub's raw 403 plus
 * "Our team has been notified" over an inline message that said something else.
 */
export async function createWorkspaceRepo(input: CreateProjectRepoInput) {
  return unwrap(
    await backendApi.post<KortixProject>('/workspaces/create-repo', input, { showErrors: false }),
  );
}

/** @deprecated Use `createWorkspaceRepo`. Kept permanently. */
export const createProjectRepo = createWorkspaceRepo;

/**
 * Create a project backed by a managed Kortix git repo — the
 * default. No GitHub account or repo-name uniqueness needed; the starter is
 * seeded server-side so the project boots immediately.
 */
export async function provisionWorkspace(
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

/** @deprecated Use `provisionWorkspace`. Kept permanently. */
export const provisionProject = provisionWorkspace;

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
 * Stable error code `provisionProjectStream` (below) puts on the error it
 * throws when the stream closes WITHOUT a terminal `done`/`error` frame
 * (`/provision-stream`'s contract is "always a terminal frame", so this
 * shape means the connection died mid-provision — a proxy idle timeout, a
 * dropped socket).
 *
 * The close is an UNKNOWN result, deliberately NOT classed as a transport
 * failure: the request demonstrably reached the server (the 200 headers
 * arrived) and may still commit or roll back — only the response was lost.
 * The host recovers it by replaying the SAME `idempotency_key` over the
 * plain `POST /projects/provision` (the key exists for exactly that), which
 * answers `409 provision_in_flight` until the first attempt commits, then
 * `201` with the same project. Client-side only: the server never emits
 * this string.
 */
export const PROVISION_STREAM_UNTERMINATED_CODE = 'provision_stream_unterminated';

/**
 * One frame of `POST /projects/provision-stream`'s SSE body.
 *
 * The `error` frame's `status` mirrors the HTTP status the equivalent
 * `/provision` response would have carried for the same failure — the route
 * (`apps/api/src/projects/routes/projects.ts`) writes `result.status` from the
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
 * Create a managed-repo project, reporting which phase the server is in as
 * it happens.
 *
 * Same create as {@link provisionWorkspace} — the server runs ONE shared
 * implementation (`runProvision` in `apps/api/src/projects/provision-core.ts`)
 * behind both `/projects/provision` and `/projects/provision-stream`. Use
 * this when a UI needs to show progress; use `provisionProject` for a plain
 * request/response.
 *
 * The stream always ends in a terminal `done` or `error` frame — the server
 * guarantees it (see the route's `finally`/catch in
 * `apps/api/src/projects/routes/projects.ts`). A stream that closes with NEITHER is
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
export async function provisionWorkspaceStream(
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
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    // A REAL `ApiError`, not a bare `Error` — see the `ProvisionStreamEvent`
    // doc comment above. `apps/web`'s `messageFor`/`isRetryableError` read
    // `.status`/`.code` off whatever `provisionProject`/`provisionProjectStream`
    // throw; without this they saw `undefined` for both on this transport.
    throw new ApiError(body?.error || `Provision failed: HTTP ${response.status}`, {
      status: response.status,
      code: body?.code,
    });
  }

  return (await readProvisionStream(response, onEvent)).project;
}

/** @deprecated Use `provisionWorkspaceStream`. Kept permanently. */
export const provisionProjectStream = provisionWorkspaceStream;

/** @deprecated Use `WorkspaceQuota`. Kept permanently. */
export interface ProjectQuota {
  /** True when the account cannot create its project: it already holds one. */
  capped: boolean;
  /** 1: a workspace holds one project. An older API sent the plan's project cap. */
  limit: number;
  /** Active projects in the account (2+ only on a legacy account the split has not reached). */
  count: number | null;
  /** The create gate's message when capped; null otherwise. */
  message: string | null;
}

/** The workspace name of {@link ProjectQuota}: the same type. */
export type WorkspaceQuota = ProjectQuota;

/**
 * Whether an account may create its project — `GET /v1/projects/quota`, from
 * the create gate's own rule, so a create form can keep its submit disabled
 * up front. To make another workspace use `createWorkspace`. Omit `accountId`
 * to resolve the same default account the create itself targets.
 *
 * An older API answered the plan's project cap and a create past it with the
 * now-deprecated 403 `project_limit_reached`; current APIs answer 409
 * `workspace_has_project` (`isWorkspaceHasProjectError`).
 */
export async function getWorkspaceQuota(options?: { accountId?: string }): Promise<ProjectQuota> {
  const query = options?.accountId ? `?account_id=${encodeURIComponent(options.accountId)}` : '';
  return unwrap(await backendApi.get<ProjectQuota>(`/projects/quota${query}`));
}

/** @deprecated Use `getWorkspaceQuota`. Kept permanently. */
export const getProjectQuota = getWorkspaceQuota;

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
      await backendApi.get<ManagedGitStatus>('/workspaces/managed-git/status', {
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
 *
 * @deprecated Use `updateWorkspace(workspaceId, input)`. Kept permanently.
 */
export async function updateProject(projectId: string, input: Partial<ProjectInput>) {
  return unwrap(await backendApi.patch<KortixProject>(`/workspaces/${projectId}`, input));
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
    await backendApi.patch<KortixProject>(`/workspaces/${projectId}/features`, {
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
    await backendApi.patch<KortixProject>(`/workspaces/${projectId}/experimental`, {
      feature,
      enabled,
    }),
  );
}

/**
 * The durable provider-migration transition the API returns on the PATCH prepare
 * branch (a switch to a different, non-default enabled provider — e.g.
 * Daytona→Platinum) and that {@link getWorkspaceSandboxProviderTransition} polls.
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
 * The result of {@link updateWorkspaceSandboxProvider}: EITHER the updated project
 * (a safe/immediate switch — null clear, the platform default, or the
 * already-active provider) tagged `kind:'project'`, OR a {@link PreparationView}
 * (the prepare branch) tagged `kind:'preparation'`. Both arrive under HTTP 200 —
 * branch on `kind`, never shape-sniff. A `kind:'preparation'` result must NOT be
 * written into the project cache; poll
 * {@link getWorkspaceSandboxProviderTransition} until it settles.
 *
 * @deprecated Use `UpdateWorkspaceSandboxProviderResult`. Kept permanently.
 */
export type UpdateProjectSandboxProviderResult =
  | ({ kind: 'project' } & KortixProject)
  | PreparationView;

/** The workspace name of {@link UpdateProjectSandboxProviderResult}: the same type. */
export type UpdateWorkspaceSandboxProviderResult = UpdateProjectSandboxProviderResult;

/** Set or clear the per-project sandbox-provider pin (Customize → Settings).
 *  Pass `null` to clear (follow the platform default/distribution). The value must
 *  be one of the project's `available_sandbox_providers`.
 *
 *  Returns a tagged union (see {@link UpdateProjectSandboxProviderResult}): a
 *  `kind:'project'` immediate result, or a `kind:'preparation'` transition the
 *  caller polls via {@link getWorkspaceSandboxProviderTransition}. */
export async function updateWorkspaceSandboxProvider(
  projectId: string,
  provider: SandboxProviderName | null,
): Promise<UpdateProjectSandboxProviderResult> {
  return unwrap(
    await backendApi.patch<UpdateProjectSandboxProviderResult>(
      `/workspaces/${projectId}/sandbox-provider`,
      { provider },
    ),
  );
}

/** @deprecated Use `updateWorkspaceSandboxProvider`. Kept permanently. */
export const updateProjectSandboxProvider = updateWorkspaceSandboxProvider;

/** Set or clear the per-project default reasoning effort (Settings → General).
 *  Pass `null` to clear (automatic). The value must be an effort label the
 *  model catalog publishes; the server validates it. Returns the updated
 *  project with `default_reasoning_effort` re-validated on read. */
export async function setDefaultReasoningEffort(
  projectId: string,
  effort: string | null,
): Promise<KortixProject> {
  return unwrap(
    await backendApi.put<KortixProject>(`/workspaces/${projectId}/default-reasoning-effort`, {
      effort,
    }),
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
 *  {@link updateWorkspaceSandboxProvider} returns a `kind:'preparation'` result,
 *  poll this until `latest` reaches a terminal status (activated / failed /
 *  superseded / cancelled) — or `latest` is null (no live transition). */
export async function getWorkspaceSandboxProviderTransition(
  projectId: string,
  options?: ApiClientOptions,
) {
  return unwrap(
    await backendApi.get<SandboxProviderTransitionState>(
      `/workspaces/${projectId}/sandbox-provider/transition`,
      { showErrors: false, ...options },
    ),
  );
}

/** @deprecated Use `getWorkspaceSandboxProviderTransition`. Kept permanently. */
export const getProjectSandboxProviderTransition = getWorkspaceSandboxProviderTransition;

/**
 * @deprecated The per-template warm pool was removed from the API. Always
 * rejects with `ENDPOINT_RETIRED`.
 */
export async function updateTemplateWarmPool(
  _projectId: string,
  _input: { slug: string; enabled?: boolean; size?: number },
): Promise<KortixProject> {
  throw retiredEndpointError('updateTemplateWarmPool');
}

export async function setWorkspaceOnboardingComplete(projectId: string, completed: boolean) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/workspaces/${projectId}/onboarding`, { completed }),
  );
}

/** @deprecated Use `setWorkspaceOnboardingComplete`. Kept permanently. */
export const setProjectOnboardingComplete = setWorkspaceOnboardingComplete;

/** Use case the account picked during guided project onboarding. */
export type OnboardingUseCase =
  | 'founder'
  | 'product_design'
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
  /** The typed answer when `use_case` is `'other'`. The API trims it and caps it at 120 characters. */
  use_case_note?: string;
  company_domain?: string;
  company_size?: OnboardingCompanySize;
}

/**
 * Persist guided-onboarding answers into `projects.metadata.onboarding`.
 *
 * Deliberately separate from {@link setWorkspaceOnboardingComplete}: completion is
 * a lifecycle flag at the top level of `metadata`, the profile is a nested
 * object, and the two are written by different steps at different times. Sending
 * `completed` from a survey save would end onboarding the moment the user
 * answered the first question.
 */
export async function setWorkspaceOnboardingProfile(projectId: string, profile: OnboardingProfile) {
  return unwrap(
    await backendApi.patch<KortixProject>(`/workspaces/${projectId}/onboarding`, { profile }),
  );
}

/** @deprecated Use `setWorkspaceOnboardingProfile`. Kept permanently. */
export const setProjectOnboardingProfile = setWorkspaceOnboardingProfile;

export async function archiveWorkspace(projectId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/workspaces/${projectId}`));
}

/** @deprecated Use `archiveWorkspace`. Kept permanently. */
export const archiveProject = archiveWorkspace;

/**
 * Move the project — and everything it owns (sessions, drives, git
 * connection, project-bound tokens, member grants) — to another account.
 *
 * The caller needs the destructive tier on the project (`project.delete`)
 * AND the right to create projects in the TARGET account; the API refuses a
 * caller who is not a member of the target (or whose target role cannot
 * create projects) with 403 before anything moves, and 403 with the target
 * account's project-cap body when the move would exceed its plan. The usage
 * ledger stays with the source account: spend stays where it was consumed.
 */
export async function transferWorkspace(projectId: string, accountId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; project_id: string; account_id: string }>(
      `/workspaces/${projectId}/transfer`,
      { account_id: accountId },
    ),
  );
}

/** @deprecated Use `transferWorkspace`. Kept permanently. */
export const transferProject = transferWorkspace;

// ── Server-side explicit-token variants ──────────────────────────────────────
// Next.js server actions / route handlers (post-signup first-project
// bootstrap) run per-request with an already-resolved Supabase access token —
// they must not rely on the SDK's process-wide `configureKortix()` seam.

/**
 * Server-side / explicit-token variant of {@link listWorkspacesForAccount}.
 * Returns `null` on any failure.
 */
export async function fetchWorkspacesForAccountWithToken(
  opts: ServerTokenOptions,
  accountId: string,
): Promise<KortixProject[] | null> {
  return serverTokenGet<KortixProject[]>(
    opts,
    `/v1/projects?account_id=${encodeURIComponent(accountId)}`,
  );
}

/** @deprecated Use `fetchWorkspacesForAccountWithToken`. Kept permanently. */
export const fetchProjectsForAccountWithToken = fetchWorkspacesForAccountWithToken;

/** @deprecated Use `ProvisionWorkspaceWithTokenResult`. Kept permanently. */
export type ProvisionProjectWithTokenResult =
  | { ok: true; project: KortixProject }
  /** `limitReached`: the account already holds its project (409 `workspace_has_project`; 403 `project_limit_reached` on an older API). */
  | { ok: false; limitReached: boolean };

/** The workspace name of {@link ProvisionProjectWithTokenResult}: the same type. */
export type ProvisionWorkspaceWithTokenResult = ProvisionProjectWithTokenResult;

/**
 * Server-side / explicit-token variant of {@link provisionWorkspace}. An
 * account that already holds its project (409 `workspace_has_project`, or the
 * deprecated 403 `project_limit_reached` of an older API) is reported as
 * `limitReached` so the caller can re-list the existing project instead of
 * treating it as a hard failure.
 */
export async function provisionWorkspaceWithToken(
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
    if (res.status === 403 || res.status === 409) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      // 409 `workspace_has_project`: the account already holds its project.
      // 403 `project_limit_reached`: the same answer from an API before the
      // workspace rule (deprecated code; current APIs never send it).
      return { ok: false, limitReached: body?.code === 'workspace_has_project' || body?.code === 'project_limit_reached' };
    }
    return { ok: false, limitReached: false };
  } catch {
    return { ok: false, limitReached: false };
  }
}

/** @deprecated Use `provisionWorkspaceWithToken`. Kept permanently. */
export const provisionProjectWithToken = provisionWorkspaceWithToken;
