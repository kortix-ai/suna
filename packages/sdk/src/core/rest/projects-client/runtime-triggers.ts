// Triggers in one list: kortix.yaml triggers and runtime triggers (loops included).
//
// A trigger is a source (what fires it) plus a target (what a fire does).
// A declared one is a kortix.yaml `triggers:` entry; change it with the trigger
// functions (`updateProjectTrigger`, …). A runtime one lives in the database —
// a loop, or one made with `createRuntimeTrigger` — and changes here.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** What fires a trigger. `schedule` covers cron, every, at and in. */
export type TriggerSourceType = 'schedule' | 'webhook' | 'event' | 'app' | 'change_request';

/** The source, with the fields its type uses (`cron`/`every`/`at`, `secret_env`, `connector`, `app`, `cr_id`/`base`). */
export interface TriggerSource {
  type: TriggerSourceType;
  cron?: string | null;
  every?: string | null;
  at?: string | null;
  timezone?: string;
  secret_env?: string | null;
  /** Where to POST a webhook trigger's deliveries. */
  webhook_url?: string;
  connector?: string | null;
  event?: string | null;
  account?: string | null;
  app?: string | null;
  /** change_request: one change request, or null for any. */
  cr_id?: string | null;
  /** change_request: merges into this branch only, or null for any. */
  base?: string | null;
}

/** What one fire does: start a session of an agent, wake one session, or call an App. */
export type TriggerTarget =
  | { kind: 'agent'; agent: string }
  | { kind: 'session'; session_id: string; session_name?: string | null }
  | { kind: 'app'; app: string };

/** One row of `listUnifiedTriggers`: a kortix.yaml trigger or a runtime one, in one shape. */
export interface UnifiedTrigger {
  /** A kortix.yaml slug (declared), or `reminder.<hex>` / `trigger.<hex>` (runtime). */
  id: string;
  /** `declared` = in kortix.yaml; `runtime` = created at runtime, in the database. */
  origin: 'declared' | 'runtime';
  name: string | null;
  prompt: string;
  agent: string;
  /** `active` fires; `paused` is off; `done` is a one-shot that fired. */
  state: 'active' | 'paused' | 'done';
  source: TriggerSource;
  target: TriggerTarget;
  next_fire_at: string | null;
  last_fired_at: string | null;
  last_status: string | null;
  last_error: string | null;
  /** Declared only: the manifest location. */
  path?: string;
  /** Runtime only: the creator's user id. */
  created_by?: string | null;
}

export interface UnifiedTriggerList {
  triggers: UnifiedTrigger[];
  triggers_paused: boolean;
  account_automations_paused: boolean;
  errors: unknown[];
}

/**
 * A runtime trigger. `target.session_id` wakes that session on each fire (a
 * loop); `target.agent` starts a new session of that agent. A schedule into a
 * session keeps the loop rules (every at least 5m). Prompts render
 * `{{ body.x }}` and `{{ change_request.number }}` against the fire's payload.
 */
export interface CreateRuntimeTriggerInput {
  prompt: string;
  name?: string;
  source:
    | { type: 'schedule'; every?: string | number; cron?: string; at?: string; in?: string | number; timezone?: string }
    | { type: 'webhook'; secret_env: string }
    | { type: 'event'; connector: string; event: string; config?: Record<string, unknown>; account?: string }
    | { type: 'app'; app: string }
    | { type: 'change_request'; cr_id?: string; base?: string };
  target: { session_id: string } | { agent: string };
}

const runtimePath = (projectId: string, triggerId: string) =>
  `/projects/${projectId}/triggers/runtime/${encodeURIComponent(triggerId)}`;

/** Every trigger the caller can see: kortix.yaml triggers, loops, and runtime triggers. */
export async function listUnifiedTriggers(projectId: string) {
  return unwrap(await backendApi.get<UnifiedTriggerList>(`/projects/${projectId}/triggers/all`));
}

/** Create a runtime trigger: stored in the database, no kortix.yaml commit. */
export async function createRuntimeTrigger(projectId: string, input: CreateRuntimeTriggerInput) {
  return unwrap(await backendApi.post<UnifiedTrigger>(`/projects/${projectId}/triggers/runtime`, input));
}

/** Pause or resume a runtime trigger. */
export async function updateRuntimeTrigger(projectId: string, triggerId: string, input: { enabled: boolean }) {
  return unwrap(await backendApi.patch<UnifiedTrigger>(runtimePath(projectId, triggerId), input));
}

/** Fire a runtime trigger once now. The schedule does not move. */
export async function runRuntimeTrigger(projectId: string, triggerId: string) {
  return unwrap(await backendApi.post<UnifiedTrigger>(`${runtimePath(projectId, triggerId)}/run`, {}));
}

export async function deleteRuntimeTrigger(projectId: string, triggerId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(runtimePath(projectId, triggerId)));
}
