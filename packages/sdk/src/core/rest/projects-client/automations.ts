// Automations — one list for triggers and loops.
//
// An automation is a source (what fires it) plus a target (what a fire does).
// A declared one is a kortix.yaml `triggers:` entry; change it with the trigger
// functions (`updateProjectTrigger`, …). A runtime one lives in the database —
// a loop, or one made with `createProjectAutomation` — and changes here.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** What fires an automation. `schedule` covers cron, every, at and in. */
export type AutomationSourceType = 'schedule' | 'webhook' | 'event' | 'app' | 'change_request';

/** The source, with the fields its type uses (`cron`/`every`/`at`, `secret_env`, `connector`, `app`, `cr_id`/`base`). */
export interface AutomationSource {
  type: AutomationSourceType;
  cron?: string | null;
  every?: string | null;
  at?: string | null;
  timezone?: string;
  secret_env?: string | null;
  /** Where to POST a webhook automation's deliveries. */
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
export type AutomationTarget =
  | { kind: 'agent'; agent: string }
  | { kind: 'session'; session_id: string; session_name?: string | null }
  | { kind: 'app'; app: string };

export interface Automation {
  /** A kortix.yaml slug (declared), or `reminder.<hex>` / `automation.<hex>` (runtime). */
  id: string;
  /** `declared` = in kortix.yaml; `runtime` = created at runtime, in the database. */
  origin: 'declared' | 'runtime';
  name: string | null;
  prompt: string;
  agent: string;
  /** `active` fires; `paused` is off; `done` is a one-shot that fired. */
  state: 'active' | 'paused' | 'done';
  source: AutomationSource;
  target: AutomationTarget;
  next_fire_at: string | null;
  last_fired_at: string | null;
  last_status: string | null;
  last_error: string | null;
  /** Declared only: the manifest location. */
  path?: string;
  /** Runtime only: the creator's user id. */
  created_by?: string | null;
}

export interface ProjectAutomationList {
  automations: Automation[];
  triggers_paused: boolean;
  account_automations_paused: boolean;
  errors: unknown[];
}

/**
 * A runtime automation. `target.session_id` wakes that session on each fire;
 * `target.agent` starts a new session of that agent. A schedule into a session
 * keeps the loop rules (every at least 5m). Prompts render `{{ body.x }}` and
 * `{{ change_request.number }}` against the fire's payload.
 */
export interface CreateProjectAutomationInput {
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

/** Every automation the caller can see: kortix.yaml triggers, loops, and runtime automations. */
export async function listProjectAutomations(projectId: string) {
  return unwrap(await backendApi.get<ProjectAutomationList>(`/projects/${projectId}/automations`));
}

export async function createProjectAutomation(projectId: string, input: CreateProjectAutomationInput) {
  return unwrap(await backendApi.post<Automation>(`/projects/${projectId}/automations`, input));
}

/** Pause or resume a runtime automation. */
export async function updateProjectAutomation(projectId: string, automationId: string, input: { enabled: boolean }) {
  return unwrap(
    await backendApi.patch<Automation>(`/projects/${projectId}/automations/${encodeURIComponent(automationId)}`, input),
  );
}

/** Fire a runtime automation once now. The schedule does not move. */
export async function runProjectAutomation(projectId: string, automationId: string) {
  return unwrap(
    await backendApi.post<Automation>(`/projects/${projectId}/automations/${encodeURIComponent(automationId)}/run`, {}),
  );
}

export async function deleteProjectAutomation(projectId: string, automationId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/automations/${encodeURIComponent(automationId)}`),
  );
}
