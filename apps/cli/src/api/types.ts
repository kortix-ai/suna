// Response shapes for the API endpoints the CLI talks to. Keep in sync with
// apps/api/src/accounts/index.ts and apps/api/src/projects/index.ts.

export interface AccountMembership {
  account_id: string;
  slug: string;
  name: string;
  role: string;
}

export interface MeResponse {
  user_id: string;
  email: string;
  token_context?: {
    auth_type: string | null;
    project_id: string | null;
    session_id: string | null;
    agent: string | null;
    connectors: string[] | 'all' | null;
    /** The agent's Kortix permissions. Absent on APIs released before 2026-09-22. */
    kortix_permissions?: string[] | 'all' | null;
    /** @deprecated Same value as `kortix_permissions`. */
    kortix_cli: string[] | 'all' | null;
    env?: string[] | 'all' | null;
  };
  accounts: AccountMembership[];
}

export interface ProjectSummary {
  project_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  /** Universal Kortix git-proxy origin (auth = Kortix token). Falls back to repo_url. */
  git_origin_url?: string;
  default_branch: string;
  manifest_path: string;
  status: 'active' | 'archived';
  metadata?: Record<string, unknown>;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  /** Web dashboard URL for this project (server-provided; not the API host). */
  dashboard_url?: string;
}

// ── Secrets ───────────────────────────────────────────────────────────────

export interface ProjectSecret {
  /** Unique per project — the handle an agent's `secrets` grant references. */
  identifier: string;
  secret_id: string;
  project_id: string;
  /** The env var KEY injected into the sandbox. Not unique — see `identifier`. */
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Whether the shared/project value exists. Mirrors the API + SDK field. */
  configured: boolean;
  /** Which value is effective for the requesting user. */
  effective_source: 'mine' | 'shared' | 'none';
  /** How the secret can leave Kortix storage — the stored column behind the
   *  exposure a user sees: `runtime` = environment, `egress` = enforced at the
   *  network, `broker`/`denied` = no sandbox presence. */
  strategy?: 'runtime' | 'egress' | 'broker' | 'denied';
  /** Service that consumes the secret. */
  consumer?:
    | 'sandbox'
    | 'llm_gateway'
    | 'connector'
    | 'git_proxy'
    | 'http_broker'
    | 'network'
    | null;
  /** Whether the selected delivery path is usable. */
  delivery_status?: 'available' | 'unavailable' | 'disabled';
  /** True when an earlier sandbox may retain the previous value. */
  requires_rotation?: boolean;
  /** Who can use the shared value; empty = everyone in the project. */
  shared_with?: Array<{
    grant_id: string;
    principal_type: 'member' | 'group' | 'project';
    principal_id: string;
    label: string;
    expires_at: string | null;
  }>;
  /** False when the value is shared with specific people and the caller is not one of them. */
  usable?: boolean;
}

export interface ProjectSecretsResponse {
  items: ProjectSecret[];
  required: string[];
  optional: string[];
  manifest_status: 'loaded' | 'missing' | 'error';
  manifest_path: string | null;
  manifest_error?: string;
  /** The calling agent's own secrets grant; null for a non-agent caller,
   *  absent on older servers. `items` is filtered by it. */
  agent_scope?: { agent: string; secrets: 'all' | string[] } | null;
}

// ── Provider OAuth ───────────────────────────────────────────────────────

export interface OauthCredentialSummary {
  provider_id: string;
  expires_in_ms: number | null;
  updated_at: string;
}

export interface OauthListResponse {
  items: OauthCredentialSummary[];
}

export interface OauthFlowStartResponse {
  flow_id: string;
  verification_url: string;
  user_code: string;
  expires_at: number;
  interval_ms: number;
}

export type OauthPollResponse =
  | {
      status: 'pending';
      next_poll_ms?: number;
    }
  | {
      status: 'success';
      credential: OauthCredentialSummary;
    }
  | {
      status: 'expired';
    }
  | {
      status: 'failed';
      error: string;
    };

// ── Sessions ──────────────────────────────────────────────────────────────

export interface ProjectSession {
  session_id: string;
  account_id: string;
  project_id: string;
  branch_name: string;
  base_ref: string;
  sandbox_provider: string;
  sandbox_id: string;
  sandbox_url: string | null;
  /** Served by a W4 API; read it before `opencode_session_id`. */
  runtime_session_id?: string | null;
  /** @deprecated The pre-W4 name of `runtime_session_id`. */
  opencode_session_id: string | null;
  /** The runtime's conversation tree (a W4 API); older APIs only have `metadata.opencode_sessions`. */
  runtime_sessions?: unknown[];
  /** Resolved display name: user-set custom_name, else the auto runtime title. */
  name: string | null;
  /** User-set name override (authoritative); null when unset. */
  custom_name: string | null;
  /** Free-form labels. Absent on a server older than labels. */
  labels?: string[];
  agent_name: string;
  status: 'queued' | 'branching' | 'provisioning' | 'running' | 'stopped' | 'failed' | 'completed';
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** The session that spawned this one; null for a top-level session. */
  parent_session_id?: string | null;
  /** Who started the run. null on rows the server could not classify. */
  initiator?: ProjectSessionInitiator | null;
  /** Visible children. Present only with `parent=root`. */
  child_count?: number;
  /** Present only with `q` + `parent=root`. */
  search_match?: 'self' | 'child';
}

export interface ProjectSessionInitiator {
  type: 'member' | 'trigger' | 'channel' | 'api' | 'system';
  id: string | null;
  label: string | null;
}

// ── Triggers ──────────────────────────────────────────────────────────────

/** A `type: monitor` trigger's shape. */
export type MonitorMode = 'poll' | 'stream';

/** A `type: event` trigger's source + subscription state. */
export interface ProjectTriggerEvent {
  connector: string;
  type: string;
  config: Record<string, unknown>;
  provider: string | null;
  app: string | null;
  status: 'active' | 'needs_connection' | 'error' | 'pending';
  error: string | null;
  last_event_at: string | null;
}

/** One event type from `GET /projects/:id/triggers/event-types`. */
export interface TriggerEventType {
  type: string;
  name: string;
  description: string;
  app: string;
  delivery: 'poll' | 'push' | null;
  /** JSON Schema of the event's `config`. */
  config_schema: Record<string, unknown>;
  payload_schema: Record<string, unknown> | null;
}

export interface TriggerEventTypesResponse {
  provider: string;
  app: string;
  event_types: TriggerEventType[];
}

/** One app from `GET /projects/:id/triggers/event-apps`. */
export interface TriggerEventApp {
  provider: string;
  app: string;
  name: string;
  logo: string | null;
  event_count: number;
  /** Slug of the project's connector for this app; null until one is added. */
  connector: string | null;
  /** The project has an active shared account for this app. */
  connected: boolean;
}

export interface TriggerEventAppsResponse {
  apps: TriggerEventApp[];
}

export interface ProjectTrigger {
  slug: string;
  path: string;
  name: string;
  type: 'cron' | 'webhook' | 'monitor' | 'event';
  agent: string;
  enabled: boolean;
  cron: string | null;
  /** One-off run instant (ISO); exclusive with cron. */
  run_at?: string | null;
  timezone: string;
  secret_env: string | null;
  /** monitor only — the repo-relative command whose stdout lines are the events. */
  run: string | null;
  /** monitor only — `poll` runs `run` every interval; `stream` keeps it alive. */
  mode: MonitorMode | null;
  /** mode='poll' only — the poll period in whole seconds. */
  interval_seconds: number | null;
  /** monitor only — the silence watchdog in whole seconds. */
  expect_event_within_seconds: number | null;
  /** type=event only; null for every other type. */
  event?: ProjectTriggerEvent | null;
  prompt_template: string;
  /** 'fresh' (default) mints a new session per fire; 'reuse' re-prompts one persistent session. */
  session_mode: 'fresh' | 'reuse';
  last_fired_at: string | null;
  /** `queued`, `fired`, or `failed` (the prompt was not delivered, or its run ended with an error). */
  last_status?: string | null;
  /** Why the last fire or run failed. */
  last_error?: string | null;
  /** ISO time of the last fire attempt or run outcome. */
  last_attempt_at?: string | null;
  webhook_url: string | null;
}

export interface ProjectTriggersResponse {
  triggers: ProjectTrigger[];
  // Server-side per-project activation state. When true, the platform won't
  // auto-run ANY of this project's triggers (cron sweep skips, webhooks ignored)
  // regardless of each trigger's own `enabled`. Toggle with `triggers pause/resume`.
  triggers_paused?: boolean;
  errors: Array<{ path: string; error: string }>;
}

export interface TriggerFireResponse {
  // 'deduped' = an identical fire is already running; the request was
  // collapsed into it (no new session). The route serves it (apps/api
  // projects/routes/triggers.ts fire handler).
  status: 'queued' | 'fired' | 'deduped';
  reason?: string | null;
  session_id?: string | null;
}

// ── Change Requests ───────────────────────────────────────────────────────

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

export interface ChangeRequestsListResponse {
  change_requests: ChangeRequest[];
}

export interface ChangeRequestDetailResponse {
  change_request: ChangeRequest;
}

export interface ChangeRequestFile {
  path: string;
  old_path: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  additions: number;
  deletions: number;
}

export interface ChangeRequestDiffResponse {
  cr_id: string;
  base_ref: string;
  head_ref: string;
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  files: ChangeRequestFile[];
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

export interface ChangeRequestMergeResponse {
  change_request: ChangeRequest;
  merge: {
    merge_commit_sha: string;
    fast_forward: boolean;
    base_sha_before: string;
    base_sha_after: string;
  };
}
