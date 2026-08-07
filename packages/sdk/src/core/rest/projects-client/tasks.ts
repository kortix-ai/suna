import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ProjectTaskStatus =
  | 'backlog'
  | 'todo'
  | 'doing'
  | 'blocked'
  | 'review'
  | 'done'
  | 'cancelled';

export interface ProjectTaskEvidence {
  ref: string;
  summary?: string;
}

export interface ProjectTask {
  task_id: string;
  project_id: string;
  goal_slug: string;
  parent_id: string | null;
  title: string;
  body: string;
  status: ProjectTaskStatus;
  priority: number;
  assignee_agent: string | null;
  assignee_user_id: string | null;
  blocked_by: string[];
  origin: string;
  origin_fingerprint: string | null;
  claim_session_id: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  liveness_worker_session_id: string | null;
  liveness_coordinator_session_id: string | null;
  liveness_worker_contract: ProjectTaskWorkerContract | null;
  liveness_started_at: string | null;
  liveness_deadline_at: string | null;
  liveness_iterations_admitted: number;
  no_progress_settlements: number;
  continuation_consumed_at: string | null;
  last_progress_at: string | null;
  last_progress_ref: string | null;
  last_no_progress_settlement_id: string | null;
  last_no_progress_action: 'continuation_queued' | 'blocked_escalation_queued' | null;
  last_no_progress_command_id: string | null;
  escalated_at: string | null;
  liveness_blocker: string | null;
  result: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ListProjectTasksOptions {
  goal_slug?: string;
  statuses?: ProjectTaskStatus[];
  limit?: number;
}

export type CreatableProjectTaskStatus = Exclude<ProjectTaskStatus, 'blocked' | 'done'>;

export interface CreateProjectTaskInput {
  goal_slug: string;
  parent_id?: string | null;
  title: string;
  body?: string;
  status?: CreatableProjectTaskStatus;
  priority?: number;
  assignee_agent?: string | null;
  assignee_user_id?: string | null;
  blocked_by?: string[];
  origin: string;
  origin_fingerprint?: string | null;
}

export interface ClaimProjectTaskInput {
  session_id: string;
  lease_seconds?: number;
}

export interface CompleteProjectTaskInput {
  session_id: string;
  evidence: ProjectTaskEvidence[];
}

export interface BlockProjectTaskInput {
  session_id: string;
  blocker: string;
}

/** Immutable server-enforced bounds for one task worker. */
export interface ProjectTaskWorkerContract {
  max_wall_seconds: number;
  max_tokens: number;
  max_cost_usd: number;
  max_iterations: number;
}

export interface RegisterProjectTaskWorkerInput {
  session_id: string;
  worker_session_id: string;
  contract: ProjectTaskWorkerContract;
  prompt: string;
}

export interface RegisterProjectTaskWorkerResponse {
  task: ProjectTask;
  worker: { session_id: string; command_id: string; state: 'queued' | 'drained' };
  contract: ProjectTaskWorkerContract;
}

export interface RecordProjectTaskProgressInput {
  session_id: string;
  worker_session_id: string;
  ref: string;
}

export interface RecordProjectTaskProgressResponse {
  task: ProjectTask;
  action: 'recorded';
}

export interface SettleNoProgressProjectTaskInput {
  session_id: string;
  worker_session_id: string;
  settlement_id: string;
  reason: string;
}

export interface SettleNoProgressProjectTaskResponse {
  action: 'continuation_queued' | 'blocked_escalation_queued';
  command_id: string;
  measured_usage: {
    total_cost: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cache_write_tokens: number;
    total_tokens: number;
    request_count: number;
  };
  task: ProjectTask;
}

function taskPath(projectId: string, taskId?: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}/tasks`;
  return taskId === undefined ? base : `${base}/${encodeURIComponent(taskId)}`;
}

export async function listProjectTasks(projectId: string, options: ListProjectTasksOptions = {}) {
  const query = new URLSearchParams();
  if (options.goal_slug !== undefined) query.set('goal_slug', options.goal_slug);
  for (const status of options.statuses ?? []) query.append('status', status);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return unwrap(await backendApi.get<{ tasks: ProjectTask[] }>(`${taskPath(projectId)}${suffix}`));
}

export async function getProjectTask(projectId: string, taskId: string) {
  return unwrap(await backendApi.get<{ task: ProjectTask }>(taskPath(projectId, taskId)));
}

export async function createProjectTask(projectId: string, input: CreateProjectTaskInput) {
  return unwrap(
    await backendApi.post<{ task: ProjectTask; created: boolean }>(taskPath(projectId), input),
  );
}

export async function claimProjectTask(
  projectId: string,
  taskId: string,
  input: ClaimProjectTaskInput,
) {
  return unwrap(
    await backendApi.post<{ task: ProjectTask }>(`${taskPath(projectId, taskId)}/claim`, input),
  );
}

export async function completeProjectTask(
  projectId: string,
  taskId: string,
  input: CompleteProjectTaskInput,
) {
  return unwrap(
    await backendApi.post<{ task: ProjectTask }>(`${taskPath(projectId, taskId)}/done`, input),
  );
}

export async function blockProjectTask(
  projectId: string,
  taskId: string,
  input: BlockProjectTaskInput,
) {
  return unwrap(
    await backendApi.post<{ task: ProjectTask }>(`${taskPath(projectId, taskId)}/block`, input),
  );
}


/** Register immutable worker bounds and enqueue its initial prompt atomically. */
export async function registerProjectTaskWorker(
  projectId: string,
  taskId: string,
  input: RegisterProjectTaskWorkerInput,
) {
  return unwrap(await backendApi.post<RegisterProjectTaskWorkerResponse>(
    `${taskPath(projectId, taskId)}/worker`, input,
  ));
}

/** Record semantic progress for the authenticated task worker. */
export async function recordProjectTaskProgress(
  projectId: string,
  taskId: string,
  input: RecordProjectTaskProgressInput,
) {
  return unwrap(await backendApi.post<RecordProjectTaskProgressResponse>(
    `${taskPath(projectId, taskId)}/progress`, input,
  ));
}

/** Atomically consume the only continuation or block and escalate. */
export async function settleNoProgressProjectTask(
  projectId: string,
  taskId: string,
  input: SettleNoProgressProjectTaskInput,
) {
  return unwrap(await backendApi.post<SettleNoProgressProjectTaskResponse>(
    `${taskPath(projectId, taskId)}/no-progress`, input,
  ));
}
