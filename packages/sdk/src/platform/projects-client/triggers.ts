// Triggers — cron/webhook triggers defined in the project manifest.

import { backendApi } from '../api-client';
import { unwrap } from './shared';

// ---------------------------------------------------------------------------
// Triggers — file-defined in the project repo at `.opencode/triggers/<slug>.md`
// (YAML frontmatter + markdown prompt body). The cloud API parses these on
// every read; CRUD endpoints commit/delete the files via the GitHub Contents
// API. The repo is the source of truth; runtime state (last_fired_at) lives
// in `project_trigger_runtime` so a fire doesn't amplify into a git commit.
// ---------------------------------------------------------------------------

export type ProjectTriggerType = 'cron' | 'webhook';

/** Parsed trigger spec — what the listing endpoint returns. */
export interface ProjectTrigger {
  /** URL-safe slug (the filename minus `.md`). */
  slug: string;
  /** Where the entry is sourced from. Always `kortix.toml#triggers.<slug>`
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
  /** The project member this trigger's automated runs act AS. A per_user
   *  connector resolves to this member's connected accounts. null = the
   *  account owner (default/legacy). */
  owner_user_id: string | null;
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
  /** The member this trigger runs as. Omit to default to the creator;
   *  null resets to the account owner. */
  owner_user_id?: string | null;
}

export interface UpdateProjectTriggerInput {
  name?: string;
  prompt_template?: string;
  agent?: string;
  /** Wire-form model (`provider/model`). null resets to the default chain. */
  model?: string | null;
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  secret_env?: string;
  /** Change who the trigger runs as. null = reset to the account owner. */
  owner_user_id?: string | null;
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
