import type { Database } from '@kortix/db';
import { projectTasks, projects } from '@kortix/db/schema';
import { AGI_AGENT_NAME } from '@kortix/shared';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { projectAgiEnabled } from './lib/platform-agi-agent';
import { enqueueCreateSessionLifecycleCommand } from './session-lifecycle/store';
import type {
  QueuedCreateSessionPayload,
  SessionLifecyclePostCreateAction,
} from './session-lifecycle/types';

export const READY_TASK_RECONCILE_LIMIT = 10;
export const READY_TASK_CLAIM_LEASE_SECONDS = 86_400;
const READY_TASK_SCAN_LIMIT = 1_000;

export interface ReadyTaskCandidate {
  projectId: string;
  accountId: string;
  projectMetadata: unknown;
  taskId: string;
  title: string;
  status: 'backlog' | 'todo';
  priority: number;
  createdAt: Date;
  updatedAt: Date;
  claimSessionId: string | null;
  dependenciesReady: boolean;
  assigneeAgent: string | null;
  assigneeUserId: string | null;
}

export interface ReadyTaskCreateRequest {
  source: 'system:task-ready-reconciler';
  projectId: string;
  accountId: string;
  actorUserId: null;
  idempotencyKey: string;
  payload: QueuedCreateSessionPayload;
}

export interface ReadyTaskReconcileResult {
  scanned: number;
  eligible: number;
  queued: number;
  deduped: number;
  commandIds: string[];
}

export function readyTaskPrompt(taskId: string): string {
  return [
    `Own task ${taskId} as its AGI coordinator.`,
    'Run `kortix tasks current --json` first and use the durable task contract as the source of truth.',
    'Coordinate one bounded worker at a time. Continue until the server completion gate verifies the task.',
  ].join(' ');
}

export function buildReadyTaskCreateRequest(candidate: ReadyTaskCandidate): ReadyTaskCreateRequest {
  const prompt = readyTaskPrompt(candidate.taskId);
  const postCreate: SessionLifecyclePostCreateAction = {
    type: 'claim_ready_task',
    taskId: candidate.taskId,
    leaseSeconds: READY_TASK_CLAIM_LEASE_SECONDS,
    prompt,
  };
  return {
    source: 'system:task-ready-reconciler',
    projectId: candidate.projectId,
    accountId: candidate.accountId,
    actorUserId: null,
    idempotencyKey: `task-ready:${candidate.projectId}:${candidate.taskId}:${candidate.updatedAt.getTime()}`,
    payload: {
      requestingPrincipalType: 'human',
      body: {
        agent_name: AGI_AGENT_NAME,
        name: `Task ${candidate.taskId}`,
      },
      metadata: {
        task_id: candidate.taskId,
        task_role: 'coordinator',
        task_ready_reconciler: true,
      },
      visibility: 'project',
      enforceAccountCap: true,
      postCreate: [postCreate],
    },
  };
}

export async function listReadyTaskCandidates(
  database: Database,
  input: { scanLimit?: number } = {},
): Promise<ReadyTaskCandidate[]> {
  const scanLimit = Math.min(
    READY_TASK_SCAN_LIMIT,
    Math.max(1, input.scanLimit ?? READY_TASK_SCAN_LIMIT),
  );
  const rows = await database
    .select({
      projectId: projectTasks.projectId,
      accountId: projects.accountId,
      projectMetadata: projects.metadata,
      taskId: projectTasks.taskId,
      title: projectTasks.title,
      status: projectTasks.status,
      priority: projectTasks.priority,
      createdAt: projectTasks.createdAt,
      updatedAt: projectTasks.updatedAt,
      claimSessionId: projectTasks.claimSessionId,
      assigneeAgent: projectTasks.assigneeAgent,
      assigneeUserId: projectTasks.assigneeUserId,
      dependenciesReady: sql<boolean>`not exists (
        select 1
        from unnest(${projectTasks.blockedBy}) blocker(task_id)
        left join ${projectTasks} dependency
          on dependency.project_id = ${projectTasks.projectId}
         and dependency.task_id = blocker.task_id
        where dependency.status is distinct from 'done'::kortix.project_task_status
      )`,
    })
    .from(projectTasks)
    .innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
    .where(
      and(
        eq(projectTasks.status, 'todo'),
        isNull(projectTasks.claimSessionId),
        or(isNull(projectTasks.assigneeAgent), eq(projectTasks.assigneeAgent, AGI_AGENT_NAME)),
        isNull(projectTasks.assigneeUserId),
        // agi currently defaults off. Keep this indexed server query
        // narrow, then re-check through the registry helper before enqueueing.
        sql`${projects.metadata}->'experimental'->>'agi' = 'true'`,
        sql`not exists (
          select 1
          from unnest(${projectTasks.blockedBy}) blocker(task_id)
          left join ${projectTasks} dependency
            on dependency.project_id = ${projectTasks.projectId}
           and dependency.task_id = blocker.task_id
          where dependency.status is distinct from 'done'::kortix.project_task_status
        )`,
      ),
    )
    .orderBy(desc(projectTasks.priority), asc(projectTasks.createdAt), asc(projectTasks.taskId))
    .limit(scanLimit);

  return rows.flatMap((row) =>
    row.status === 'backlog' || row.status === 'todo' ? [{ ...row, status: row.status }] : [],
  );
}

export async function reconcileReadyProjectTasks(
  input: {
    database?: Database;
    limit?: number;
    listCandidates?: () => Promise<ReadyTaskCandidate[]>;
    enqueue?: (
      request: ReadyTaskCreateRequest,
    ) => Promise<{ commandId: string; existing: boolean }>;
  } = {},
): Promise<ReadyTaskReconcileResult> {
  const database = input.database ?? db;
  const limit = Math.min(
    READY_TASK_RECONCILE_LIMIT,
    Math.max(1, input.limit ?? READY_TASK_RECONCILE_LIMIT),
  );
  const candidates = input.listCandidates
    ? await input.listCandidates()
    : await listReadyTaskCandidates(database);
  const eligible = candidates
    .filter(
      (candidate) =>
        projectAgiEnabled(candidate.projectMetadata) &&
        candidate.dependenciesReady &&
        candidate.claimSessionId === null &&
        candidate.status === 'todo' &&
        (candidate.assigneeAgent === null || candidate.assigneeAgent === AGI_AGENT_NAME) &&
        candidate.assigneeUserId === null,
    )
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.taskId.localeCompare(right.taskId),
    )
    .slice(0, limit);

  const result: ReadyTaskReconcileResult = {
    scanned: candidates.length,
    eligible: eligible.length,
    queued: 0,
    deduped: 0,
    commandIds: [],
  };
  for (const candidate of eligible) {
    const request = buildReadyTaskCreateRequest(candidate);
    const queued = input.enqueue
      ? await input.enqueue(request)
      : await enqueueCreateSessionLifecycleCommand(database, request).then(({ row, existing }) => ({
          commandId: row.commandId,
          existing,
        }));
    result.commandIds.push(queued.commandId);
    if (queued.existing) result.deduped += 1;
    else result.queued += 1;
  }
  return result;
}
