// Triggers — cron/webhook triggers defined in the project manifest.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ---------------------------------------------------------------------------
// Triggers — defined in `kortix.yaml#triggers`. The cloud API parses the
// project manifest on every read; CRUD endpoints commit manifest edits through
// the GitHub Contents API. The repo is the source of truth; runtime state
// (last_fired_at) lives in `project_trigger_runtime` so a fire doesn't amplify
// into a git commit.
// ---------------------------------------------------------------------------

export type ProjectTriggerType = 'cron' | 'webhook';

/**
 * How each fire uses sessions:
 * - `fresh` (default) — a brand-new session per run.
 * - `reuse` — always re-prompt this trigger's own long-lived session.
 * - `pinned` — always re-prompt one specific `session_id`.
 * - `keyed` — one session PER rendered `session_key` value, so a single
 *   trigger fans out into a session per chat / customer / repo.
 */
export type ProjectTriggerSessionMode = 'fresh' | 'reuse' | 'pinned' | 'keyed';

/** Parsed trigger spec — what the listing endpoint returns. */
export interface ProjectTrigger {
  /** URL-safe slug (the filename minus `.md`). */
  slug: string;
  /** Where the entry is sourced from. Always `kortix.yaml#triggers.<slug>`
   *  now that triggers are centralized in the manifest. */
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
  last_fired_at: string | null;
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
  /** Session strategy across fires. Omit for the default 'fresh'. */
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
  session_mode?: ProjectTriggerSessionMode;
  session_id?: string | null;
  /** See {@link CreateProjectTriggerInput.session_key}. null clears it. */
  session_key?: string | null;
  /** null or {} clears the filter. */
  filter?: Record<string, string> | null;
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
