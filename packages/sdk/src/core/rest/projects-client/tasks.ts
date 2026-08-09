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

export type TaskVerificationKind =
  | 'command'
  | 'http'
  | 'artifact'
  | 'deployment'
  | 'policy'
  | 'human'
  | 'monitor';

export interface TaskVerificationRequirement {
  id: string;
  kind: TaskVerificationKind;
  description: string;
  required: boolean;
}

export interface TaskReviewPolicy {
  mode: 'auto' | 'human';
}

export interface ProjectTask {
  task_id: string;
  project_id: string;
  goal_slug: string | null;
  parent_id: string | null;
  title: string;
  body: string;
  /** Versioned V1 completion contract. Present on servers with the task control plane. */
  intent?: string;
  constraints?: string[];
  out_of_scope?: string[];
  contract_revision?: number;
  /** Null identifies a historical task. One identifies the V1 task control plane. */
  control_plane_version?: number | null;
  verification_requirements?: TaskVerificationRequirement[];
  review_policy?: TaskReviewPolicy;
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
  /** Server-owned identity that must be used for the current worker-turn outcome. */
  liveness_turn_id: string | null;
  no_progress_settlements: number;
  continuation_consumed_at: string | null;
  last_progress_at: string | null;
  last_progress_ref: string | null;
  last_no_progress_settlement_id: string | null;
  last_no_progress_action: 'continuation_queued' | 'blocked_escalation_queued' | null;
  last_no_progress_command_id: string | null;
  escalated_at: string | null;
  liveness_blocker: string | null;
  completed_at?: string | null;
  result: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ListProjectTasksOptions {
  goal_slug?: string;
  statuses?: ProjectTaskStatus[];
  limit?: number;
}

export type CreatableProjectTaskStatus = 'backlog' | 'todo';

export interface CreateProjectTaskInput {
  goal_slug?: string | null;
  parent_id?: string | null;
  title: string;
  body?: string;
  intent?: string;
  constraints?: string[];
  out_of_scope?: string[];
  verification_requirements?: TaskVerificationRequirement[];
  review_policy?: TaskReviewPolicy;
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

export interface ReviseProjectTaskContractInput {
  intent?: string;
  constraints?: string[];
  out_of_scope?: string[];
  verification_requirements?: TaskVerificationRequirement[];
  review_policy?: TaskReviewPolicy;
}

export interface TaskEvidenceRecord {
  evidence_id: string;
  project_id: string;
  task_id: string;
  session_id: string | null;
  contract_revision: number;
  requirement_id: string | null;
  kind: string;
  ref: string;
  summary: string;
  candidate_digest: string;
  state: 'passed' | 'failed' | 'info';
  created_at: string;
}

export interface AddProjectTaskEvidenceInput {
  requirement_id?: string | null;
  kind: string;
  ref: string;
  summary?: string;
  candidate_digest: string;
  state: TaskEvidenceRecord['state'];
}

export interface RequestProjectTaskCompletionInput {
  candidate_digest: string;
  session_id?: string;
}

export interface TaskCompletionUnmetCondition {
  code: string;
  requirement_id?: string;
  message: string;
}

export interface TaskBlocker {
  blocker_id: string;
  project_id: string;
  task_id: string;
  category: string;
  requested_action: string;
  target: Record<string, unknown>;
  request_digest: string;
  attempts_made: string[];
  status: 'open' | 'resolved' | 'canceled' | 'expired';
  next_reminder_at: string | null;
  expires_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectTaskBlockerInput {
  category: string;
  requested_action: string;
  target?: Record<string, unknown>;
  request_digest: string;
  attempts_made?: string[];
  next_reminder_at?: string | null;
  expires_at?: string | null;
  session_id?: string;
}

export interface TaskEvent {
  event_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TaskSessionLink {
  task_id: string;
  session_id: string;
  role: 'coordinator' | 'worker' | 'verifier';
  parent_session_id: string | null;
  created_at: string;
}

export interface TaskMessage {
  message_id: string;
  task_id: string;
  sender_session_id: string | null;
  recipient_session_id: string | null;
  type: string;
  body: Record<string, unknown>;
  correlation_id: string | null;
  idempotency_key: string;
  status: 'accepted' | 'queued' | 'delivered' | 'processed' | 'failed' | 'expired';
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SendProjectTaskMessageInput {
  recipient_session_id?: string | null;
  type: string;
  body: Record<string, unknown>;
  correlation_id?: string | null;
  idempotency_key: string;
}

export type TaskRefinementScope = 'task' | 'agent' | 'project' | 'account' | 'platform';

export interface TaskRefinementProposal {
  proposal_id: string;
  task_id: string | null;
  scope: TaskRefinementScope;
  observation: string;
  base_revision: string;
  patch: Record<string, unknown>;
  rollback_patch: Record<string, unknown>;
  evidence_refs: string[];
  status: 'proposed' | 'applied' | 'rejected' | 'rolled_back';
  created_by_session_id: string | null;
  applied_at: string | null;
  rolled_back_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProposeProjectTaskRefinementInput {
  task_id?: string | null;
  scope: TaskRefinementScope;
  observation: string;
  base_revision: string;
  patch: Record<string, unknown>;
  evidence_refs?: string[];
}

/** Immutable server-enforced bounds for one task worker. */
export interface ProjectTaskWorkerContract {
  max_wall_seconds: number;
  max_tokens: number;
  max_cost_usd: number;
  /** PostgreSQL integer. Inclusive range: 1 through 2,147,483,647. */
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
  worker: {
    session_id: string;
    command_id: string;
    state: 'queued' | 'drained';
  };
  contract: ProjectTaskWorkerContract;
}

export interface RecordProjectTaskProgressInput {
  session_id: string;
  worker_session_id: string;
  settlement_id: string;
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

/** Idempotently release an unused task claim after coordinator launch compensation. */
export async function releaseProjectTaskClaim(
  projectId: string,
  taskId: string,
  input: { session_id: string },
) {
  return unwrap(
    await backendApi.post<{ task: ProjectTask; released: boolean }>(
      `${taskPath(projectId, taskId)}/release-claim`,
      input,
    ),
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

/** Resolve the durable task bound to the authenticated session principal. */
export async function getCurrentProjectTask(projectId: string) {
  return unwrap(await backendApi.get<{ task: ProjectTask }>(`${taskPath(projectId)}/current`));
}

/** Create a human-authored revision of the task outcome and verification contract. */
export async function reviseProjectTaskContract(
  projectId: string,
  taskId: string,
  input: ReviseProjectTaskContractInput,
) {
  return unwrap(
    await backendApi.patch<{ task: ProjectTask }>(`${taskPath(projectId, taskId)}/contract`, input),
  );
}

export async function listProjectTaskEvidence(projectId: string, taskId: string) {
  return unwrap(
    await backendApi.get<{ evidence: TaskEvidenceRecord[] }>(
      `${taskPath(projectId, taskId)}/evidence`,
    ),
  );
}

export async function addProjectTaskEvidence(
  projectId: string,
  taskId: string,
  input: AddProjectTaskEvidenceInput,
) {
  return unwrap(
    await backendApi.post<{ evidence: TaskEvidenceRecord }>(
      `${taskPath(projectId, taskId)}/evidence`,
      input,
    ),
  );
}

export async function requestProjectTaskCompletion(
  projectId: string,
  taskId: string,
  input: RequestProjectTaskCompletionInput,
) {
  return unwrap(
    await backendApi.post<{ task: ProjectTask }>(
      `${taskPath(projectId, taskId)}/request-completion`,
      input,
    ),
  );
}

export async function listProjectTaskBlockers(projectId: string, taskId: string) {
  return unwrap(
    await backendApi.get<{ blockers: TaskBlocker[] }>(`${taskPath(projectId, taskId)}/blockers`),
  );
}

export async function createProjectTaskBlocker(
  projectId: string,
  taskId: string,
  input: CreateProjectTaskBlockerInput,
) {
  return unwrap(
    await backendApi.post<{ blocker: TaskBlocker; created: boolean }>(
      `${taskPath(projectId, taskId)}/blockers`,
      input,
    ),
  );
}

export async function resolveProjectTaskBlocker(
  projectId: string,
  taskId: string,
  blockerId: string,
) {
  return unwrap(
    await backendApi.post<{ blocker: TaskBlocker }>(
      `${taskPath(projectId, taskId)}/blockers/${encodeURIComponent(blockerId)}/resolve`,
      {},
    ),
  );
}

export async function listProjectTaskEvents(projectId: string, taskId: string, limit?: number) {
  const suffix = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  return unwrap(
    await backendApi.get<{ events: TaskEvent[] }>(`${taskPath(projectId, taskId)}/events${suffix}`),
  );
}

export async function listProjectTaskSessionLinks(projectId: string, taskId: string) {
  return unwrap(
    await backendApi.get<{ sessions: TaskSessionLink[] }>(
      `${taskPath(projectId, taskId)}/sessions`,
    ),
  );
}

export async function listProjectTaskMessages(projectId: string, taskId: string) {
  return unwrap(
    await backendApi.get<{ messages: TaskMessage[] }>(`${taskPath(projectId, taskId)}/messages`),
  );
}

export async function sendProjectTaskMessage(
  projectId: string,
  taskId: string,
  input: SendProjectTaskMessageInput,
) {
  return unwrap(
    await backendApi.post<{ message: TaskMessage; created: boolean }>(
      `${taskPath(projectId, taskId)}/messages`,
      input,
    ),
  );
}

export async function acknowledgeProjectTaskMessage(
  projectId: string,
  taskId: string,
  messageId: string,
) {
  return unwrap(
    await backendApi.post<{ message: TaskMessage }>(
      `${taskPath(projectId, taskId)}/messages/${encodeURIComponent(messageId)}/ack`,
      {},
    ),
  );
}

export async function cancelProjectTask(
  projectId: string,
  taskId: string,
  input: { reason: string },
) {
  return unwrap(
    await backendApi.post<{ task: ProjectTask }>(`${taskPath(projectId, taskId)}/cancel`, input),
  );
}

export async function listProjectTaskRefinements(projectId: string) {
  return unwrap(
    await backendApi.get<{ refinements: TaskRefinementProposal[] }>(
      `/projects/${encodeURIComponent(projectId)}/refinements`,
    ),
  );
}

export async function proposeProjectTaskRefinement(
  projectId: string,
  input: ProposeProjectTaskRefinementInput,
) {
  return unwrap(
    await backendApi.post<{ refinement: TaskRefinementProposal }>(
      `/projects/${encodeURIComponent(projectId)}/refinements`,
      input,
    ),
  );
}

export async function rollbackProjectTaskRefinement(projectId: string, proposalId: string) {
  return unwrap(
    await backendApi.post<{ refinement: TaskRefinementProposal }>(
      `/projects/${encodeURIComponent(projectId)}/refinements/${encodeURIComponent(proposalId)}/rollback`,
      {},
    ),
  );
}

const WORKER_CONTRACT_PLATFORM_CEILINGS = {
  max_wall_seconds: 3_600,
  max_tokens: 1_000_000,
  max_cost_usd: 25,
  max_iterations: 128,
} as const;

function assertWorkerContractWithinPlatformCeilings(contract: ProjectTaskWorkerContract): void {
  for (const field of ['max_wall_seconds', 'max_tokens', 'max_iterations'] as const) {
    const value = contract[field];
    const maximum = WORKER_CONTRACT_PLATFORM_CEILINGS[field];
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(`${field} must be between 1 and ${maximum}`);
    }
  }
  if (
    !Number.isFinite(contract.max_cost_usd) ||
    contract.max_cost_usd <= 0 ||
    contract.max_cost_usd > WORKER_CONTRACT_PLATFORM_CEILINGS.max_cost_usd
  ) {
    throw new RangeError(
      `max_cost_usd must be between 0 (exclusive) and ${WORKER_CONTRACT_PLATFORM_CEILINGS.max_cost_usd}`,
    );
  }
}

/** Register immutable worker bounds and enqueue its initial prompt atomically. */
export async function registerProjectTaskWorker(
  projectId: string,
  taskId: string,
  input: RegisterProjectTaskWorkerInput,
) {
  assertWorkerContractWithinPlatformCeilings(input.contract);
  return unwrap(
    await backendApi.post<RegisterProjectTaskWorkerResponse>(
      `${taskPath(projectId, taskId)}/worker`,
      input,
    ),
  );
}

/** Record semantic progress for the authenticated task worker. */
export async function recordProjectTaskProgress(
  projectId: string,
  taskId: string,
  input: RecordProjectTaskProgressInput,
) {
  return unwrap(
    await backendApi.post<RecordProjectTaskProgressResponse>(
      `${taskPath(projectId, taskId)}/progress`,
      input,
    ),
  );
}

/** Atomically consume the only continuation or block and escalate. */
export async function settleNoProgressProjectTask(
  projectId: string,
  taskId: string,
  input: SettleNoProgressProjectTaskInput,
) {
  return unwrap(
    await backendApi.post<SettleNoProgressProjectTaskResponse>(
      `${taskPath(projectId, taskId)}/no-progress`,
      input,
    ),
  );
}
