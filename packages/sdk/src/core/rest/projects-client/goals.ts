import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ProjectGoalStatus = 'active' | 'achieved' | 'paused' | 'abandoned';
export type ProjectGoalMetricDirection = 'increase' | 'decrease';

export interface ProjectGoalMetric {
  name: string;
  direction: ProjectGoalMetricDirection;
  target: number | null;
  unit: string | null;
}

export interface ProjectGoal {
  slug: string;
  path: string;
  title: string;
  done_when: string;
  status: ProjectGoalStatus;
  push_cron: string | null;
  timezone: string;
  agent: string | null;
  metrics: ProjectGoalMetric[];
}

export interface ProjectGoalParseError {
  slug: string;
  path: string;
  error: string;
}

export interface ProjectGoalListing {
  goals: ProjectGoal[];
  errors: ProjectGoalParseError[];
}

export type ProjectGoalEvaluationState = 'queued' | 'fired' | 'failed';
export type ProjectGoalHealthStatus = 'unmeasurable' | 'stalled' | 'measuring';

export interface ProjectGoalMetricHealth {
  metric: string;
  status: ProjectGoalHealthStatus;
  evaluation_id: string | null;
  evaluation_state: ProjectGoalEvaluationState | null;
  observation_value: number | null;
}

export interface ProjectGoalHealth {
  goal_slug: string;
  desired_status: ProjectGoalStatus;
  health_status: ProjectGoalHealthStatus;
  metrics: ProjectGoalMetricHealth[];
}

export interface ProjectGoalPushOptions {
  /** Stable retry key for one logical manual goal push. */
  idempotencyKey?: string;
}

export interface ProjectGoalPushResponse {
  status: 'queued' | 'fired' | 'deduped';
  evaluation_id: string;
  evaluation_state: ProjectGoalEvaluationState;
  command_id?: string | null;
  session_id?: string | null;
  reason?: string | null;
  deduped?: boolean;
}

export interface ProjectGoalObservation {
  observation_id: string;
  project_id: string;
  goal_slug: string;
  evaluation_id: string | null;
  metric: string;
  value: number;
  source: string;
  session_id: string | null;
  observed_at: string;
  created_at: string;
}

export interface RecordProjectGoalObservationInput {
  /** Evaluation returned by the goal push that produced this metric value. */
  evaluation_id: string;
  metric: string;
  value: number;
  source: string;
  /** @deprecated Session principals are attributed from authentication. Human principals cannot impersonate a session. */
  session_id?: string;
  observed_at?: string;
}

export interface ListProjectGoalObservationsOptions {
  metric: string;
  from?: string;
  to?: string;
  limit?: number;
}

function goalPath(projectId: string, slug?: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}/goals`;
  return slug === undefined ? base : `${base}/${encodeURIComponent(slug)}`;
}

export async function listProjectGoals(projectId: string) {
  return unwrap(await backendApi.get<ProjectGoalListing>(goalPath(projectId)));
}

export async function getProjectGoal(projectId: string, slug: string) {
  return unwrap(await backendApi.get<{ goal: ProjectGoal }>(goalPath(projectId, slug)));
}

export async function getProjectGoalHealth(projectId: string, slug: string) {
  return unwrap(
    await backendApi.get<{ health: ProjectGoalHealth }>(`${goalPath(projectId, slug)}/health`),
  );
}

export async function pushProjectGoal(
  projectId: string,
  slug: string,
  options: ProjectGoalPushOptions = {},
) {
  return unwrap(
    await backendApi.post<ProjectGoalPushResponse>(
      `${goalPath(projectId, slug)}/push`,
      {},
      options.idempotencyKey
        ? { headers: { 'Idempotency-Key': options.idempotencyKey } }
        : undefined,
    ),
  );
}

export async function recordProjectGoalObservation(
  projectId: string,
  slug: string,
  input: RecordProjectGoalObservationInput,
) {
  return unwrap(
    await backendApi.post<{ observation: ProjectGoalObservation }>(
      `${goalPath(projectId, slug)}/observations`,
      input,
    ),
  );
}

export async function listProjectGoalObservations(
  projectId: string,
  slug: string,
  options: ListProjectGoalObservationsOptions,
) {
  const query = new URLSearchParams({ metric: options.metric });
  if (options.from !== undefined) query.set('from', options.from);
  if (options.to !== undefined) query.set('to', options.to);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  return unwrap(
    await backendApi.get<{ observations: ProjectGoalObservation[] }>(
      `${goalPath(projectId, slug)}/observations?${query.toString()}`,
    ),
  );
}
