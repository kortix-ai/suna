// Triggers — cron/webhook/monitor triggers defined in the project manifest.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ---------------------------------------------------------------------------
// Triggers — file-defined in the project repo at `.opencode/triggers/<slug>.md`
// (YAML frontmatter + markdown prompt body). The cloud API parses these on
// every read; CRUD endpoints commit/delete the files via the GitHub Contents
// API. The repo is the source of truth; runtime state (last_fired_at) lives
// in `project_trigger_runtime` so a fire doesn't amplify into a git commit.
// ---------------------------------------------------------------------------

export type ProjectTriggerType = 'cron' | 'webhook' | 'monitor' | 'event';

/**
 * How the platform runs a `type: monitor` trigger's `run` command:
 * - `poll` — run it every `interval`, print, exit.
 * - `stream` — run it once and keep it alive.
 *
 * Both shapes emit events as stdout lines, so nothing downstream (filter →
 * prompt template → session_mode) can tell them apart.
 */
export type ProjectMonitorMode = 'poll' | 'stream';

/**
 * How each fire uses sessions:
 * - `fresh` (default) — a brand-new session per run.
 * - `reuse` — always re-prompt this trigger's own long-lived session.
 * - `pinned` — always re-prompt one specific `session_id`.
 * - `keyed` — one session PER rendered `session_key` value, so a single
 *   trigger fans out into a session per chat / customer / repo.
 */
export type ProjectTriggerSessionMode = 'fresh' | 'reuse' | 'pinned' | 'keyed';

/**
 * Who may open sessions created by this trigger. The trigger agent remains the
 * owner. Project managers always retain access, including in `private` mode.
 */
export interface TriggerSessionAccess {
  mode: 'private' | 'project' | 'members';
  memberIds: string[];
  groupIds: string[];
}

/** Subscription state of a `type: event` trigger. */
export interface ProjectTriggerEvent {
  /** The connector (profile) the event happens on. */
  connector: string;
  /** Declared `account` label; null = the connector's default shared account. */
  account?: string | null;
  /** Identity (or label) of the shared account actually feeding the trigger; null when none. */
  connected_as?: string | null;
  /** Provider event type id, e.g. `GITHUB_PULL_REQUEST_EVENT`. */
  type: string;
  config: Record<string, unknown>;
  /** Event source adapter: the declared `source`, else the connector's provider (e.g. `composio`). Null when unresolved. */
  source?: string | null;
  /** @deprecated Same value as `source`. */
  provider: string | null;
  /** Provider app slug (e.g. `github`). Null when unresolved. */
  app: string | null;
  /** `pending` = declared but no subscription yet. */
  status: 'active' | 'needs_connection' | 'error' | 'pending';
  error: string | null;
  last_event_at: string | null;
}

/** Parsed trigger spec — what the listing endpoint returns. */
export interface ProjectTrigger {
  /** URL-safe slug (the filename minus `.md`). */
  slug: string;
  /** Where the entry is declared: `<file>#triggers.<slug>`. `<file>` is
   *  `kortix.yaml`, or the imported file when the manifest's `imports:`
   *  brought the trigger in (e.g. `.kortix/triggers/weekly.yaml`). */
  path: string;
  name: string;
  type: ProjectTriggerType;
  agent: string;
  /** Wire-form model (`provider/model`) pinned to this trigger's runs, or
   *  null to resolve the default chain (agent → project → account →
   *  platform) at fire time. */
  model: string | null;
  enabled: boolean;
  cron: string | null;
  /** ISO-8601 instant for a one-off ("run once") schedule; null for recurring/webhook. */
  run_at: string | null;
  timezone: string;
  /** project_secrets key holding the webhook HMAC secret. */
  secret_env: string | null;
  /**
   * For type='monitor' only — the repo-relative command the platform
   * supervises 24/7 in the project's monitor box. Its stdout lines are the
   * events; nothing else is. Null on cron/webhook.
   */
  run: string | null;
  /** For type='monitor' only — see {@link ProjectMonitorMode}. Null otherwise. */
  mode: ProjectMonitorMode | null;
  /** For mode='poll' only — the poll period in whole seconds. Null otherwise. */
  interval_seconds: number | null;
  /**
   * For type='monitor' only — the silence watchdog in whole seconds. No event
   * inside this window synthesizes a `silent` lifecycle event, so a wedged
   * monitor can never fail silently. Null when the monitor declares none.
   */
  expect_event_within_seconds: number | null;
  /** For type='event' only — see {@link ProjectTriggerEvent}. Null otherwise. */
  event: ProjectTriggerEvent | null;
  prompt_template: string;
  /** Session strategy — see {@link ProjectTriggerSessionMode}. */
  session_mode: ProjectTriggerSessionMode;
  /** For session_mode === 'pinned' only: the session id looped. Null otherwise. */
  session_id: string | null;
  /**
   * For session_mode === 'keyed' only: the `{{ body.path }}` template rendered
   * against each delivery to pick which session handles it. Null otherwise.
   * Setting it is itself the opt-in — the API infers `session_mode: 'keyed'`
   * from a non-empty key unless a different mode is sent explicitly.
   */
  session_key: string | null;
  /**
   * Payload paths (dotted, rooted at the same `body`/`headers` object the
   * prompt template sees) mapped to the value they must equal for the trigger
   * to fire. A non-matching delivery is accepted but spawns no session. Null
   * when unfiltered.
   */
  filter: Record<string, string> | null;
  /** Access policy applied to every session this trigger creates. */
  session_access: TriggerSessionAccess;
  last_fired_at: string | null;
  /**
   * The trigger's most recent outcome: `queued` (a prompt waits for its
   * session), `fired` (delivered, or the last run succeeded), or `failed` (the
   * prompt was not delivered, or the run it started ended with an error).
   * A failed run stays `failed` across later fires until a run finishes.
   * Null before the first fire.
   */
  last_status?: string | null;
  /** Why the last fire or run failed, e.g. "Out of credits: …". Null otherwise. */
  last_error?: string | null;
  /** ISO time of the last fire attempt or run outcome. */
  last_attempt_at?: string | null;
  /** ISO time an enabled cron trigger runs next: the slot the scheduler
   *  claims, jitter included. Null for a webhook trigger, and from an older API. */
  next_fire_at?: string | null;
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
  /**
   * Server-side, per-project kill-switch (`projects.metadata.triggers_paused`).
   * When true the platform auto-runs NONE of this project's triggers — the cron
   * sweep skips it and inbound webhooks are acknowledged-but-ignored, regardless
   * of each trigger's repo `enabled`. Manual `fire` still works. Use it to stop
   * ONE repo deployed to two control planes (e.g. dev + prod) from double-firing.
   */
  triggers_paused?: boolean;
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
  /** Wire-form model (`provider/model`). Omit or pass null to resolve the
   *  default chain (agent → project → account → platform) at fire time. */
  model?: string | null;
  enabled?: boolean;
  /** For type='cron'. 6-field croner expression. Omit when using `run_at`. */
  cron?: string;
  /** For type='cron'. ISO-8601 instant for a one-off run. Mutually exclusive with `cron`. */
  run_at?: string;
  /** For type='cron'. IANA timezone. Defaults to 'UTC'. */
  timezone?: string;
  /** For type='webhook'. Name of a project_secrets entry. */
  secret_env?: string;
  /** Required for type='monitor'. Repo-relative command whose stdout lines fire. */
  run?: string;
  /** Required for type='monitor'. See {@link ProjectMonitorMode}. */
  mode?: ProjectMonitorMode;
  /**
   * Required for mode='poll', rejected on mode='stream'. Duration literal
   * (`30s`, `5m`, `24h`, `7d`), floor 30s. Never a bare number.
   */
  interval?: string;
  /** For type='monitor'. Silence watchdog as a duration literal; floor 5m. */
  expect_event_within?: string;
  /** Required for type='event'. Connector slug the event happens on. */
  connector?: string;
  /** For type='event'. Label of one shared account of the connector; omit or null for the connector default. */
  event_account?: string | null;
  /** For type='event'. Event source adapter id such as `composio`; omit for the connector's provider. */
  event_source?: string | null;
  /** Required for type='event'. The adapter's event type id from {@link listProjectTriggerEventTypes}. */
  event?: string;
  /** For type='event'. Provider event config, shaped by the event type's `config_schema`. */
  event_config?: Record<string, unknown>;
  /**
   * Session strategy across fires. Omit for the type's default — 'fresh' on
   * cron/webhook, 'reuse' on monitor (a monitor fires repeatedly by design, so
   * 'fresh' would mint a session per event).
   */
  session_mode?: ProjectTriggerSessionMode;
  /** Required when session_mode === 'pinned': the session id to loop. */
  session_id?: string | null;
  /**
   * `{{ body.path }}` template that buckets sessions by key. Sending it is
   * enough — the API infers `session_mode: 'keyed'` unless another mode is
   * sent explicitly.
   */
  session_key?: string | null;
  /** Payload paths mapped to the value they must equal for the trigger to fire. */
  filter?: Record<string, string> | null;
  /** Defaults to private. This is account-local runtime state, not manifest config. */
  session_access?: TriggerSessionAccess;
}

export interface UpdateProjectTriggerInput {
  name?: string;
  prompt_template?: string;
  agent?: string;
  /** Wire-form model (`provider/model`). null resets to the default chain. */
  model?: string | null;
  enabled?: boolean;
  cron?: string | null;
  /** ISO-8601 instant for a one-off run; null clears it back to a `cron`. */
  run_at?: string | null;
  timezone?: string;
  secret_env?: string;
  /** For type='monitor'. Repo-relative command whose stdout lines fire. */
  run?: string;
  /** For type='monitor'. See {@link ProjectMonitorMode}. */
  mode?: ProjectMonitorMode;
  /**
   * For mode='poll'. Duration literal (`30s`, `5m`, `24h`, `7d`), floor 30s.
   * null clears it — required when switching a poll monitor to 'stream'.
   */
  interval?: string | null;
  /** For type='monitor'. Duration literal, floor 5m. null clears the watchdog. */
  expect_event_within?: string | null;
  /** For type='event'. Connector slug. Changing it clears the account unless `event_account` is sent. */
  connector?: string;
  /** For type='event'. Label of one shared account of the connector; null clears it to the connector default. */
  event_account?: string | null;
  /** For type='event'. Event source adapter id; null clears it to the connector's provider. Changing `connector` clears it unless sent. */
  event_source?: string | null;
  /** For type='event'. The adapter's event type id. */
  event?: string;
  /** For type='event'. Replaces the provider event config. */
  event_config?: Record<string, unknown>;
  session_mode?: ProjectTriggerSessionMode;
  session_id?: string | null;
  /** See {@link CreateProjectTriggerInput.session_key}. null clears it. */
  session_key?: string | null;
  /** null or {} clears the filter. */
  filter?: Record<string, string> | null;
  /** Replaces the policy and updates prior sessions created by this trigger. */
  session_access?: TriggerSessionAccess;
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

/**
 * Pause or resume ALL of a project's triggers server-side (the per-project
 * kill-switch — see {@link ProjectTriggerListing.triggers_paused}). Returns the
 * updated trigger listing, including the new `triggers_paused` value.
 */
export async function setProjectTriggersActivation(
  projectId: string,
  paused: boolean,
) {
  return unwrap(
    await backendApi.patch<ProjectTriggerListing>(
      `/projects/${projectId}/triggers/activation`,
      { paused },
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

/** One app event a connector can trigger on. */
export interface ProjectTriggerEventType {
  type: string;
  name: string;
  description: string;
  app: string;
  /** How the provider delivers it; null when unknown. */
  delivery: 'poll' | 'push' | null;
  /** JSON Schema of the `event_config` this event accepts. */
  config_schema: Record<string, unknown>;
  /** JSON Schema of the `event.data` a prompt template reads. Null when unpublished. */
  payload_schema: Record<string, unknown> | null;
}

export interface ProjectTriggerEventTypes {
  /** Event source adapter id, such as `composio`. */
  source?: string;
  /** @deprecated Same value as `source`. */
  provider: string;
  app: string;
  event_types: ProjectTriggerEventType[];
}

/**
 * The app events a connector can trigger on. Throws 404 for an unknown
 * connector and 409 `event_source_unavailable` when its provider has no event source.
 */
export async function listProjectTriggerEventTypes(
  projectId: string,
  params: { connector: string },
) {
  return unwrap(
    await backendApi.get<ProjectTriggerEventTypes>(
      `/projects/${projectId}/triggers/event-types?connector=${encodeURIComponent(params.connector)}`,
    ),
  );
}

/** One shared account of a connector: the only kind that can feed an event trigger. */
export interface ProjectTriggerEventAccount {
  /** The account's label; unique per connector. This is the trigger's `account`. */
  label: string;
  /** Identity the account was authorized as; null when unknown. */
  connected_as: string | null;
  /** The connector's default shared account: used when a trigger names no `account`. */
  is_default: boolean;
  /** Authorization finished; a trigger can run on it. */
  connected: boolean;
}

/** A connector (profile) of an app, with its shared accounts. */
export interface ProjectTriggerEventConnector {
  slug: string;
  name: string;
  accounts: ProjectTriggerEventAccount[];
}

/** An app that can trigger events, with the project's state for it. */
export interface ProjectTriggerEventApp {
  /** Event source adapter id, such as `composio`. The trigger's `event_source`. */
  source?: string;
  /** @deprecated Same value as `source`. */
  provider: string;
  /** Provider app slug. */
  app: string;
  name: string;
  logo: string | null;
  event_count: number;
  /** Slug of the project's connector for this app; null until one is added. */
  connector: string | null;
  /** The project has an active shared account for this app. An event trigger runs on it. */
  connected: boolean;
  /** Every connector (profile) of this app with its shared accounts. */
  connectors?: ProjectTriggerEventConnector[];
  /** Slug to give a new connector for this app (never a reserved or taken one). */
  new_connector_slug?: string;
}

export interface ProjectTriggerEventApps {
  apps: ProjectTriggerEventApp[];
}

/** Apps with at least one event type, with connector and connection state for this project. */
export async function listProjectTriggerEventApps(projectId: string) {
  return unwrap(await backendApi.get<ProjectTriggerEventApps>(`/projects/${projectId}/triggers/event-apps`));
}
