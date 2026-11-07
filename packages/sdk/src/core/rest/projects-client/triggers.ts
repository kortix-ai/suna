// Triggers — cron/webhook/monitor/event/app triggers defined in the project manifest.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ---------------------------------------------------------------------------
// Triggers — file-defined in the project repo at `.opencode/triggers/<slug>.md`
// (YAML frontmatter + markdown prompt body). The cloud API parses these on
// every read; CRUD endpoints commit/delete the files via the GitHub Contents
// API. The repo is the source of truth; runtime state (last_fired_at) lives
// in `project_trigger_runtime` so a fire doesn't amplify into a git commit.
// ---------------------------------------------------------------------------

/**
 * `'monitor'` is deprecated: the monitor box was removed, and the API answers
 * 400 to a new monitor trigger. An App with a schedule or a `type: app`
 * trigger replaces it. The member stays until the next major.
 *
 * `'change_request'` fires when a change request of the project merges; its
 * `filter.base` names the branch (any branch when absent).
 *
 * @deprecated Use `WorkspaceTriggerType`. Kept permanently.
 */
export type ProjectTriggerType = 'cron' | 'webhook' | 'monitor' | 'event' | 'app' | 'change_request';

/** The workspace name of {@link ProjectTriggerType}: the same type. */
export type WorkspaceTriggerType = ProjectTriggerType;

/**
 * @deprecated The monitor box was removed; the API sends `null`. Removed in the next major.
 *
 * How the platform ran a `type: monitor` trigger's `run` command:
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
 *
 * @deprecated Use `WorkspaceTriggerSessionMode`. Kept permanently.
 */
export type ProjectTriggerSessionMode = 'fresh' | 'reuse' | 'pinned' | 'keyed';

/** The workspace name of {@link ProjectTriggerSessionMode}: the same type. */
export type WorkspaceTriggerSessionMode = ProjectTriggerSessionMode;

/**
 * Who may open sessions created by this trigger. The trigger agent remains the
 * owner. Project managers always retain access, including in `private` mode.
 */
export interface TriggerSessionAccess {
  mode: 'private' | 'project' | 'members';
  memberIds: string[];
  groupIds: string[];
}

/**
 * What a fire calls when a trigger targets an App: `method path` on the App, with the fire's payload.
 *
 * @deprecated Use `WorkspaceTriggerTarget`. Kept permanently.
 */
export interface ProjectTriggerTarget {
  app: string;
  path: string;
  method: 'POST' | 'GET';
  /** Fixed JSON body the call sends instead of the fire's payload. */
  payload?: Record<string, unknown>;
}

/** The workspace name of {@link ProjectTriggerTarget}: the same type. */
export type WorkspaceTriggerTarget = ProjectTriggerTarget;

/**
 * Subscription state of a `type: event` trigger.
 *
 * @deprecated Use `WorkspaceTriggerEvent`. Kept permanently.
 */
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
  /** Source `mcp`: when Kortix last checked the app with success. Null for other sources and before the first check. */
  checked_at?: string | null;
  /** Source `mcp`: when Kortix checks the app next. Null for other sources, and while the trigger is not subscribed. */
  next_check_at?: string | null;
}

/** The workspace name of {@link ProjectTriggerEvent}: the same type. */
export type WorkspaceTriggerEvent = ProjectTriggerEvent;

/** Parsed trigger spec — what the listing endpoint returns. */
/**
 * One trigger filter condition (KRTX-1721): exactly one operator. `not` and
 * `in` compare the payload value as text; `prefix` and `not_prefix` test how
 * it starts; `exists` tests that it is present and not null. A missing path
 * reads as an empty string.
 */
export type TriggerFilterCondition =
  | { not: string[] }
  | { in: string[] }
  | { exists: boolean }
  | { prefix: string[] }
  | { not_prefix: string[] };

/** A filter path's condition: a string means "equals". */
export type TriggerFilterValue = string | TriggerFilterCondition;

/** @deprecated Use `WorkspaceTrigger`. Kept permanently. */
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
  /** @deprecated The monitor box was removed; always `null`. Removed in the next major. */
  run: string | null;
  /** @deprecated The monitor box was removed; always `null`. Removed in the next major. */
  mode: ProjectMonitorMode | null;
  /** @deprecated The monitor box was removed; always `null`. Removed in the next major. */
  interval_seconds: number | null;
  /**
   * For type='app' only: the silence alert (`expect_event_within`), in whole
   * seconds. Null on every other type and when unset.
   */
  expect_event_within_seconds: number | null;
  /**
   * For type='app' only: when its App last posted to it (a deduplicated post
   * and `kortix.heartbeat` count). Null before the first post. Absent on older servers.
   */
  last_event_at?: string | null;
  /**
   * Set while the App has been silent past `expect_event_within`: when the
   * silence alert started. The App's next post clears it. Absent on older servers.
   */
  silent_since?: string | null;
  /**
   * Set while the always-on App it names is down: it stopped 3 times in an
   * hour and Kortix stopped restarting it. When that alert started; the App
   * running again clears it. Absent on older servers.
   */
  crashed_since?: string | null;
  /** For type='event' only — see {@link ProjectTriggerEvent}. Null otherwise. */
  event: ProjectTriggerEvent | null;
  /** For type='app' only — the slug of the App whose emitted events fire this trigger. Null or absent otherwise. */
  app?: string | null;
  /** A fire calls this App instead of running an agent. Null or absent: an agent run. */
  target?: ProjectTriggerTarget | null;
  /** For type='cron' with `every` — the fixed period in whole seconds. Null or absent otherwise. */
  every_seconds?: number | null;
  prompt_template: string;
  /** Session strategy — see {@link ProjectTriggerSessionMode}. */
  session_mode: ProjectTriggerSessionMode;
  /**
   * Runs the trigger may start in any 60 minutes. Null when unset: the
   * default, 60, applies. A fire past it starts nothing and is recorded as a
   * skipped run, `throttled: …`. Optional: older servers omit it.
   */
  max_runs_per_hour?: number | null;
  /** Runs the trigger may start in a UTC day. Null when unset: no daily cap. */
  max_runs_per_day?: number | null;
  /**
   * (KRTX-1721) `skip` holds a fire while the trigger's previous run is still
   * active; in reuse, pinned and keyed mode, while its previous prompt still
   * waits in the session queue. Null when unset: `skip` for a cron trigger,
   * `allow` for the others. Optional: older servers omit it.
   */
  overlap?: 'skip' | 'allow' | null;
  /**
   * Set while the trigger paused itself (KRTX-1721): it ran at its hourly run
   * limit through the previous hour and was still being held. No automatic fire
   * starts a run until it is resumed: `updateProjectTrigger(…, { enabled: true })`.
   * Absent on older servers.
   */
  auto_paused_at?: string | null;
  /** Why it paused, e.g. `auto-paused: ran at max_runs_per_hour 60 for 2 hours in a row`. */
  auto_paused_reason?: string | null;
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
   * prompt template sees) mapped to the condition each must meet for the
   * trigger to fire: a value it must equal, or one operator
   * ({@link TriggerFilterCondition}). A non-matching delivery is accepted but
   * spawns no session. Null when unfiltered.
   */
  filter: Record<string, TriggerFilterValue> | null;
  /** Access policy applied to every session this trigger creates. */
  session_access: TriggerSessionAccess;
  /**
   * The channel or DM (`ProjectSpace.space_id`) its runs post to as threads;
   * null = none, the run lands in `#general`. Present only while the project's
   * `chat` flag is on; older servers omit it.
   */
  space_id?: string | null;
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
  /** Next exact cron occurrence, without scheduler jitter. Absent from older APIs. */
  next_cron_at?: string | null;
  /** Public fire URL for webhook triggers; null for cron. */
  webhook_url: string | null;
}

/** The workspace name of {@link ProjectTrigger}: the same type. */
export type WorkspaceTrigger = ProjectTrigger;

/** Parse error surfaced by the listing endpoint so the UI can render
 * broken triggers next to green ones.
 *
 * @deprecated Use `WorkspaceTriggerParseError`. Kept permanently.
 */
export interface ProjectTriggerParseError {
  slug: string;
  path: string;
  error: string;
}

/** The workspace name of {@link ProjectTriggerParseError}: the same type. */
export type WorkspaceTriggerParseError = ProjectTriggerParseError;

/** @deprecated Use `WorkspaceTriggerListing`. Kept permanently. */
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
  /**
   * The account's Pause all triggers (`PATCH /accounts/:id/automations`):
   * true stops every automatic fire in every project of the account, this one
   * included. Manual `fire` still works. Older servers omit it.
   */
  account_automations_paused?: boolean;
}

/** The workspace name of {@link ProjectTriggerListing}: the same type. */
export type WorkspaceTriggerListing = ProjectTriggerListing;

/** @deprecated Use `CreateWorkspaceTriggerInput`. Kept permanently. */
export interface CreateProjectTriggerInput {
  /** Required — used as the title and shown in the UI. */
  name: string;
  /**
   * Optional slug override. When omitted, derived from `name`. Once
   * created, the slug is immutable (changing it would orphan runtime state).
   */
  slug?: string;
  type: ProjectTriggerType;
  prompt_template?: string;
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
  /** @deprecated The monitor box was removed; the API refuses monitor triggers. Removed in the next major. */
  run?: string;
  /** @deprecated The monitor box was removed; the API refuses monitor triggers. Removed in the next major. */
  mode?: ProjectMonitorMode;
  /** @deprecated The monitor box was removed; the API refuses monitor triggers. Removed in the next major. */
  interval?: string;
  /** @deprecated The monitor box was removed; the API refuses monitor triggers. Removed in the next major. */
  expect_event_within?: string;
  /** Required for type='app'. Slug of the App whose events fire the trigger; the App must exist. */
  app?: string;
  /** Call an App instead of running an agent; `prompt_template` is then optional. */
  target?: { app: string; path?: string; method?: 'POST' | 'GET'; payload?: Record<string, unknown> };
  /** For type='cron'. A fixed period such as `5m`, `1h`, `1d` (at least 1m) instead of `cron` or `run_at`. */
  every?: string;
  /** Required for type='event'. Connector slug the event happens on. */
  connector?: string;
  /** For type='event'. Label of one shared account of the connector; omit or null for the connector default. */
  event_account?: string | null;
  /** For type='event'. Event source adapter id such as `composio`; omit for the connector's provider. */
  event_source?: string | null;
  /** Required for type='event'. The adapter's event type id from {@link listWorkspaceTriggerEventTypes}. */
  event?: string;
  /** For type='event'. Provider event config, shaped by the event type's `config_schema`. */
  event_config?: Record<string, unknown>;
  /** Runs it may start in any 60 minutes, a whole number ≥ 1. Omit for the default, 60. */
  max_runs_per_hour?: number;
  /** Runs it may start in a UTC day, a whole number ≥ 1. Omit for no daily cap. */
  max_runs_per_day?: number;
  /** See {@link ProjectTrigger.overlap}. Omit for the type's default. */
  overlap?: 'skip' | 'allow';
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
  /** Payload paths mapped to the condition each must meet for the trigger to fire. See {@link ProjectTrigger.filter}. */
  filter?: Record<string, TriggerFilterValue> | null;
  /** Defaults to private, or project when `space_id` is a channel. This is account-local runtime state, not manifest config. */
  session_access?: TriggerSessionAccess;
  /**
   * The channel or DM its runs post to as threads (`chat` flag;
   * ignored while it is off). A DM must be the caller's own (else 403
   * `space_forbidden`) and the trigger must run the DM's agent (else 400
   * `agent_mismatch`). A DM run is shared with the DM's member whatever
   * `session_access` says; like every trigger run, trigger managers and account
   * owners and admins can also open it. An unknown or archived space rejects
   * with 404 `space_not_found`. A change applies to later runs only.
   */
  space_id?: string | null;
}

/** The workspace name of {@link CreateProjectTriggerInput}: the same type. */
export type CreateWorkspaceTriggerInput = CreateProjectTriggerInput;

/** @deprecated Use `UpdateWorkspaceTriggerInput`. Kept permanently. */
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
  /** @deprecated The monitor box was removed; the API refuses monitor triggers. Removed in the next major. */
  run?: string;
  /** @deprecated The monitor box was removed; the API refuses monitor triggers. Removed in the next major. */
  mode?: ProjectMonitorMode;
  /** @deprecated The monitor box was removed; the API refuses monitor triggers. Removed in the next major. */
  interval?: string | null;
  /** @deprecated The monitor box was removed; the API refuses monitor triggers. Removed in the next major. */
  expect_event_within?: string | null;
  /** For type='app'. Slug of the App whose events fire the trigger. */
  app?: string;
  /** Call an App instead of running an agent; null clears it. */
  target?: { app: string; path?: string; method?: 'POST' | 'GET'; payload?: Record<string, unknown> } | null;
  /** For type='cron'. A fixed period such as `5m`; null clears it. */
  every?: string | null;
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
  /** null resets it to the default, 60. */
  max_runs_per_hour?: number | null;
  /** null removes the daily cap. */
  max_runs_per_day?: number | null;
  /** See {@link ProjectTrigger.overlap}. null resets it to the type's default. */
  overlap?: 'skip' | 'allow' | null;
  session_mode?: ProjectTriggerSessionMode;
  session_id?: string | null;
  /** See {@link CreateProjectTriggerInput.session_key}. null clears it. */
  session_key?: string | null;
  /** Replaces the whole filter. null or {} clears it. */
  filter?: Record<string, TriggerFilterValue> | null;
  /** Replaces the policy and updates prior sessions created by this trigger, except those in a DM. */
  session_access?: TriggerSessionAccess;
  /** See {@link CreateProjectTriggerInput.space_id}. null clears it; a move into a channel without `session_access` makes its later threads project-visible. Another member's DM trigger accepts only `space_id` and `enabled` (else 403). */
  space_id?: string | null;
}

/** The workspace name of {@link UpdateProjectTriggerInput}: the same type. */
export type UpdateWorkspaceTriggerInput = UpdateProjectTriggerInput;

export async function listWorkspaceTriggers(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectTriggerListing>(
      `/workspaces/${projectId}/triggers`,
    ),
  );
}

/** @deprecated Use `listWorkspaceTriggers`. Kept permanently. */
export const listProjectTriggers = listWorkspaceTriggers;

export async function createWorkspaceTrigger(
  projectId: string,
  input: CreateProjectTriggerInput,
) {
  return unwrap(
    await backendApi.post<ProjectTriggerListing>(
      `/workspaces/${projectId}/triggers`,
      input,
    ),
  );
}

/** @deprecated Use `createWorkspaceTrigger`. Kept permanently. */
export const createProjectTrigger = createWorkspaceTrigger;

export async function updateWorkspaceTrigger(
  projectId: string,
  slug: string,
  input: UpdateProjectTriggerInput,
) {
  return unwrap(
    await backendApi.patch<ProjectTriggerListing>(
      `/workspaces/${projectId}/triggers/${slug}`,
      input,
    ),
  );
}

/** @deprecated Use `updateWorkspaceTrigger`. Kept permanently. */
export const updateProjectTrigger = updateWorkspaceTrigger;

export async function deleteWorkspaceTrigger(projectId: string, slug: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${projectId}/triggers/${slug}`,
    ),
  );
}

/** @deprecated Use `deleteWorkspaceTrigger`. Kept permanently. */
export const deleteProjectTrigger = deleteWorkspaceTrigger;

/**
 * The account's Pause all triggers: `paused` stops every automatic fire in
 * every project of the account — schedules, loops (reminders), webhooks, app events and
 * monitors. A manual fire still runs.
 */
export interface AccountAutomationsStatus {
  paused: boolean;
  paused_at: string | null;
  /** The user who paused them; null while running. */
  paused_by: string | null;
  /** True when the caller may pause or resume (account.write). */
  can_change: boolean;
}

export async function getAccountAutomations(accountId: string) {
  return unwrap(await backendApi.get<AccountAutomationsStatus>(`/accounts/${accountId}/automations`));
}

/** Pause or resume every trigger of the account. Needs account.write (owners and admins by default). */
export async function setAccountAutomationsPaused(accountId: string, paused: boolean) {
  return unwrap(
    await backendApi.patch<AccountAutomationsStatus>(`/accounts/${accountId}/automations`, { paused }, { showErrors: false }),
  );
}

/**
 * Pause or resume ALL of a project's triggers server-side (the per-project
 * kill-switch — see {@link ProjectTriggerListing.triggers_paused}). Returns the
 * updated trigger listing, including the new `triggers_paused` value.
 */
export async function setWorkspaceTriggersActivation(
  projectId: string,
  paused: boolean,
) {
  return unwrap(
    await backendApi.patch<ProjectTriggerListing>(
      `/workspaces/${projectId}/triggers/activation`,
      { paused },
    ),
  );
}

/** @deprecated Use `setWorkspaceTriggersActivation`. Kept permanently. */
export const setProjectTriggersActivation = setWorkspaceTriggersActivation;

/** @deprecated Use `FireWorkspaceTriggerResponse`. Kept permanently. */
export interface FireProjectTriggerResponse {
  /** `deduped`: an identical fire is already in flight; nothing new was started. */
  status: 'fired' | 'queued' | 'deduped' | 'failed';
  session_id?: string | null;
  /** The lifecycle command a queued fire waits on; null when none was written. */
  command_id?: string | null;
  /** True when this fire matched one already in flight. */
  deduped?: boolean;
  /** The run this fire wrote to the trigger's history; null when the write failed. */
  run_id?: string | null;
  reason?: string | null;
  error?: string;
}

/** The workspace name of {@link FireProjectTriggerResponse}: the same type. */
export type FireWorkspaceTriggerResponse = FireProjectTriggerResponse;

/**
 * Options of {@link fireWorkspaceTrigger}. Omit them for a plain manual fire.
 *
 * @deprecated Use `FireWorkspaceTriggerOptions`. Kept permanently.
 */
export interface FireProjectTriggerOptions {
  /** Deep-merged over the manual base payload at the root, e.g. `{ body: {…} }` for a webhook template. */
  payload?: Record<string, unknown>;
  /** Render the prompt and evaluate the filter only: no session, no command, no run. */
  dryRun?: boolean;
}

/** The workspace name of {@link FireProjectTriggerOptions}: the same type. */
export type FireWorkspaceTriggerOptions = FireProjectTriggerOptions;

/**
 * What a real fire would send. `fireProjectTrigger(…, { dryRun: true })` writes nothing.
 *
 * @deprecated Use `WorkspaceTriggerDryRunResult`. Kept permanently.
 */
export interface ProjectTriggerDryRunResult {
  dry_run: true;
  rendered_prompt: string;
  /** False when the trigger's `filter` would skip this payload. */
  filter_matches: boolean;
  /** The rendered key of a `keyed` trigger; null otherwise. */
  session_key: string | null;
  /** The merged payload, unredacted (it is the caller's own input). */
  payload: Record<string, unknown>;
}

/** The workspace name of {@link ProjectTriggerDryRunResult}: the same type. */
export type WorkspaceTriggerDryRunResult = ProjectTriggerDryRunResult;

/**
 * What fired a run.
 *
 * @deprecated Use `WorkspaceTriggerRunSource`. Kept permanently.
 */
export type ProjectTriggerRunSource = 'cron' | 'webhook' | 'manual' | 'monitor' | 'reminder' | 'event' | 'app' | 'change_request';

/** The workspace name of {@link ProjectTriggerRunSource}: the same type. */
export type WorkspaceTriggerRunSource = ProjectTriggerRunSource;

/**
 * A run's fire outcome. `fired` = a session was started or prompted;
 * `rejected` = a webhook delivery refused before its signature verified.
 *
 * @deprecated Use `WorkspaceTriggerRunStatus`. Kept permanently.
 */
export type ProjectTriggerRunStatus = 'queued' | 'running' | 'fired' | 'failed' | 'skipped' | 'rejected';

/** The workspace name of {@link ProjectTriggerRunStatus}: the same type. */
export type WorkspaceTriggerRunStatus = ProjectTriggerRunStatus;

/**
 * One fire of a trigger, from any source, as the run history lists it.
 *
 * @deprecated Use `WorkspaceTriggerRun`. Kept permanently.
 */
export interface ProjectTriggerRun {
  run_id: string;
  slug: string;
  source: ProjectTriggerRunSource;
  status: ProjectTriggerRunStatus;
  /** The agent turn's outcome; null when the run started no turn. */
  run_status: 'running' | 'succeeded' | 'failed' | null;
  /** Why the fire failed, was skipped or was rejected. */
  error: string | null;
  /** Why the agent turn failed (`stopped` for a stopped turn). */
  run_error: string | null;
  session_id: string | null;
  command_id: string | null;
  /** The run this one replayed, or null. */
  replay_of: string | null;
  /** False for a webhook delivery refused before its signature verified. Replay then needs `confirmUnverified`. */
  payload_verified: boolean;
  /**
   * The fire's payload. Values under secret-looking keys read `[redacted]`.
   * An oversized payload reads `{ truncated: true, bytes }` and cannot be replayed.
   */
  payload: Record<string, unknown>;
  scheduled_for: string;
  created_at: string;
  started_at: string;
  /** Null while the run waits, runs, or its turn is still going. */
  ended_at: string | null;
  duration_ms: number | null;
  /** LLM spend of the run's session between `started_at` and `ended_at` (or now). Null without a session. */
  cost_usd: number | null;
}

/** The workspace name of {@link ProjectTriggerRun}: the same type. */
export type WorkspaceTriggerRun = ProjectTriggerRun;

/**
 * One page of runs, newest first.
 *
 * @deprecated Use `WorkspaceTriggerRunList`. Kept permanently.
 */
export interface ProjectTriggerRunList {
  runs: ProjectTriggerRun[];
  /**
   * Pass as `cursor` for the next page; null on the last page. A page can hold
   * fewer than `limit` runs (or none) while `next_cursor` is set: follow it.
   */
  next_cursor: string | null;
}

/** The workspace name of {@link ProjectTriggerRunList}: the same type. */
export type WorkspaceTriggerRunList = ProjectTriggerRunList;

/** Paging of {@link listTriggerRuns}. `limit` is 1–100, default 25. */
export interface ListTriggerRunsOptions {
  cursor?: string;
  limit?: number;
}

/**
 * Paging and filter of {@link listWorkspaceTriggerRuns}.
 *
 * @deprecated Use `ListWorkspaceTriggerRunsOptions`. Kept permanently.
 */
export interface ListProjectTriggerRunsOptions extends ListTriggerRunsOptions {
  status?: ProjectTriggerRunStatus;
}

/** The workspace name of {@link ListProjectTriggerRunsOptions}: the same type. */
export type ListWorkspaceTriggerRunsOptions = ListProjectTriggerRunsOptions;

function runsQuery(options: ListProjectTriggerRunsOptions | undefined) {
  const q = new URLSearchParams();
  if (options?.status) q.set('status', options.status);
  if (options?.limit != null) q.set('limit', String(options.limit));
  if (options?.cursor) q.set('cursor', options.cursor);
  const qs = q.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Run a trigger now. It works while triggers are paused. With `payload` the
 * prompt renders against that payload; with `dryRun: true` nothing is
 * written and the rendered prompt comes back instead.
 */
export async function fireWorkspaceTrigger(
  projectId: string,
  slug: string,
  options: FireProjectTriggerOptions & { dryRun: true },
): Promise<ProjectTriggerDryRunResult>;
export async function fireWorkspaceTrigger(
  projectId: string,
  slug: string,
  options?: FireProjectTriggerOptions & { dryRun?: false },
): Promise<FireProjectTriggerResponse>;
export async function fireWorkspaceTrigger(
  projectId: string,
  slug: string,
  options?: FireProjectTriggerOptions,
): Promise<FireProjectTriggerResponse | ProjectTriggerDryRunResult>;
export async function fireWorkspaceTrigger(projectId: string, slug: string, options?: FireProjectTriggerOptions) {
  const body: { payload?: Record<string, unknown>; dry_run?: boolean } = {};
  if (options?.payload !== undefined) body.payload = options.payload;
  if (options?.dryRun !== undefined) body.dry_run = options.dryRun;
  return unwrap(
    await backendApi.post<FireProjectTriggerResponse | ProjectTriggerDryRunResult>(
      `/workspaces/${projectId}/triggers/${slug}/fire`,
      body,
    ),
  );
}

/** @deprecated Use `fireWorkspaceTrigger`. Kept permanently. */
export const fireProjectTrigger = fireWorkspaceTrigger;

/** One trigger's runs, newest first. Follow `next_cursor` to page. */
export async function listTriggerRuns(projectId: string, slug: string, options?: ListTriggerRunsOptions) {
  return unwrap(
    await backendApi.get<ProjectTriggerRunList>(
      `/workspaces/${projectId}/triggers/${slug}/runs${runsQuery(options)}`,
    ),
  );
}

/** Every trigger run of the project the caller may see, newest first. `failed` includes dead-lettered runs. */
export async function listWorkspaceTriggerRuns(projectId: string, options?: ListProjectTriggerRunsOptions) {
  return unwrap(
    await backendApi.get<ProjectTriggerRunList>(`/workspaces/${projectId}/trigger-runs${runsQuery(options)}`),
  );
}

/** @deprecated Use `listWorkspaceTriggerRuns`. Kept permanently. */
export const listProjectTriggerRuns = listWorkspaceTriggerRuns;

/** Options of {@link replayTriggerRun}. */
export interface ReplayTriggerRunOptions {
  /** Required to replay a run whose `payload_verified` is false. */
  confirmUnverified?: boolean;
}

/**
 * Fire a trigger again with a past run's stored payload and the current spec.
 * Throws: 404 unknown run (or a run of another trigger), 409
 * `run_in_progress` while the run is queued or running, 409
 * `payload_unverified` without `confirmUnverified`, 422 `payload_truncated`.
 */
export async function replayTriggerRun(
  projectId: string,
  slug: string,
  runId: string,
  options?: ReplayTriggerRunOptions,
) {
  return unwrap(
    await backendApi.post<FireProjectTriggerResponse>(
      `/workspaces/${projectId}/triggers/${slug}/runs/${runId}/replay`,
      options?.confirmUnverified ? { confirm_unverified: true } : {},
    ),
  );
}

/**
 * One app event a connector can trigger on.
 *
 * @deprecated Use `WorkspaceTriggerEventType`. Kept permanently.
 */
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

/** The workspace name of {@link ProjectTriggerEventType}: the same type. */
export type WorkspaceTriggerEventType = ProjectTriggerEventType;

/** @deprecated Use `WorkspaceTriggerEventTypes`. Kept permanently. */
export interface ProjectTriggerEventTypes {
  /** Event source adapter id: `composio` or `mcp`. */
  source?: string;
  /** @deprecated Same value as `source`. */
  provider: string;
  app: string;
  event_types: ProjectTriggerEventType[];
}

/** The workspace name of {@link ProjectTriggerEventTypes}: the same type. */
export type WorkspaceTriggerEventTypes = ProjectTriggerEventTypes;

/**
 * The app events a connector, or an app with no connector, can trigger on.
 * Throws 404 for an unknown connector (`app_not_found` for an app with no
 * events), 400 for an unknown `source`, and 409 `event_source_unavailable`
 * when no event source serves it. With source `mcp`, a catalogue app or a
 * project MCP server that has no events yet returns an empty `event_types`.
 */
export async function listWorkspaceTriggerEventTypes(
  projectId: string,
  params: { connector: string } | { app: string; source?: string },
) {
  const query =
    'connector' in params
      ? `connector=${encodeURIComponent(params.connector)}`
      : `app=${encodeURIComponent(params.app)}${params.source ? `&source=${encodeURIComponent(params.source)}` : ''}`;
  return unwrap(
    await backendApi.get<ProjectTriggerEventTypes>(`/workspaces/${projectId}/triggers/event-types?${query}`),
  );
}

/** @deprecated Use `listWorkspaceTriggerEventTypes`. Kept permanently. */
export const listProjectTriggerEventTypes = listWorkspaceTriggerEventTypes;

/**
 * One shared account of a connector: the only kind that can feed an event trigger.
 *
 * @deprecated Use `WorkspaceTriggerEventAccount`. Kept permanently.
 */
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

/** The workspace name of {@link ProjectTriggerEventAccount}: the same type. */
export type WorkspaceTriggerEventAccount = ProjectTriggerEventAccount;

/**
 * A connector (profile) of an app, with its shared accounts.
 *
 * @deprecated Use `WorkspaceTriggerEventConnector`. Kept permanently.
 */
export interface ProjectTriggerEventConnector {
  slug: string;
  name: string;
  accounts: ProjectTriggerEventAccount[];
}

/** The workspace name of {@link ProjectTriggerEventConnector}: the same type. */
export type WorkspaceTriggerEventConnector = ProjectTriggerEventConnector;

/**
 * An app that can trigger events, with the project's state for it.
 *
 * @deprecated Use `WorkspaceTriggerEventApp`. Kept permanently.
 */
export interface ProjectTriggerEventApp {
  /** Event source adapter id: `composio` or `mcp`. The trigger's `event_source`. */
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
  /** Source mcp: the catalogue MCP server to install for this app. Null for other sources and for a project MCP server outside the catalogue. */
  mcp_url?: string | null;
}

/** The workspace name of {@link ProjectTriggerEventApp}: the same type. */
export type WorkspaceTriggerEventApp = ProjectTriggerEventApp;

/** @deprecated Use `WorkspaceTriggerEventApps`. Kept permanently. */
export interface ProjectTriggerEventApps {
  apps: ProjectTriggerEventApp[];
}

/** The workspace name of {@link ProjectTriggerEventApps}: the same type. */
export type WorkspaceTriggerEventApps = ProjectTriggerEventApps;

/** Apps with at least one event type, with connector and connection state for this project. */
export async function listWorkspaceTriggerEventApps(projectId: string) {
  return unwrap(await backendApi.get<ProjectTriggerEventApps>(`/workspaces/${projectId}/triggers/event-apps`));
}

/** @deprecated Use `listWorkspaceTriggerEventApps`. Kept permanently. */
export const listProjectTriggerEventApps = listWorkspaceTriggerEventApps;
