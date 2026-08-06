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
