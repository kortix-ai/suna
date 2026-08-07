export const MIN_TASK_LEASE_SECONDS = 30;
export const MAX_TASK_LEASE_SECONDS = 86_400;

export interface TaskEvidence {
  ref: string;
  summary?: string;
}

export class GoalsTasksServiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoalsTasksServiceError';
  }
}

export function mapGeneratedStateError(
  error: unknown,
): { status: 409; code: string; error: string } | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  if (
    code !== 'TASK_CLAIM_CONFLICT' &&
    code !== 'TASK_TRANSITION_CONFLICT' &&
    code !== 'TASK_LIVENESS_CONFLICT'
  ) return null;
  return {
    status: 409,
    code: code.toLowerCase(),
    error: error instanceof Error ? error.message : 'Task has a live claim',
  };
}

export async function claimTaskForProject<T>(
  dependencies: {
    sessionBelongsToProject(projectId: string, sessionId: string): Promise<boolean>;
    claimTask(input: {
      projectId: string;
      taskId: string;
      sessionId: string;
      now: Date;
      leaseMs: number;
    }): Promise<T>;
  },
  input: {
    projectId: string;
    taskId: string;
    sessionId: string;
    authenticatedSessionId?: string | null;
    leaseSeconds: number;
    now: Date;
  },
): Promise<T> {
  if (
    !Number.isSafeInteger(input.leaseSeconds) ||
    input.leaseSeconds < MIN_TASK_LEASE_SECONDS ||
    input.leaseSeconds > MAX_TASK_LEASE_SECONDS
  ) {
    throw new GoalsTasksServiceError(
      400,
      'invalid_lease_seconds',
      `lease_seconds must be an integer between ${MIN_TASK_LEASE_SECONDS} and ${MAX_TASK_LEASE_SECONDS}`,
    );
  }
  assertSessionIdentity(input);
  if (!(await dependencies.sessionBelongsToProject(input.projectId, input.sessionId))) {
    throw new GoalsTasksServiceError(
      400,
      'session_not_in_project',
      'session_id must belong to this project',
    );
  }
  try {
    return await dependencies.claimTask({
      projectId: input.projectId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      now: input.now,
      leaseMs: input.leaseSeconds * 1_000,
    });
  } catch (error) {
    const conflict = mapGeneratedStateError(error);
    if (conflict) throw new GoalsTasksServiceError(409, conflict.code, conflict.error);
    throw error;
  }
}

export async function completeTaskForProject<T>(
  dependencies: {
    sessionBelongsToProject: (projectId: string, sessionId: string) => Promise<boolean>;
    transitionTask(input: {
      projectId: string;
      taskId: string;
      status: 'done';
      expectedClaimSessionId: string;
      result: { evidence: TaskEvidence[] };
      now: Date;
    }): Promise<T | null>;
  },
  input: {
    projectId: string;
    taskId: string;
    evidence: TaskEvidence[];
    sessionId: string;
    authenticatedSessionId?: string | null;
    now: Date;
  },
): Promise<T> {
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length === 0 ||
    input.evidence.some(
      (evidence) =>
        !evidence || typeof evidence.ref !== 'string' || evidence.ref.trim().length === 0,
    )
  ) {
    throw new GoalsTasksServiceError(
      400,
      'evidence_required',
      'evidence must be a non-empty array of cited refs',
    );
  }
  assertSessionIdentity(input);
  await assertProjectSession(dependencies, input);
  try {
    const task = await dependencies.transitionTask({
      projectId: input.projectId,
      taskId: input.taskId,
      status: 'done',
      expectedClaimSessionId: input.sessionId,
      result: { evidence: input.evidence },
      now: input.now,
    });
    if (!task) throw new GoalsTasksServiceError(404, 'task_not_found', 'Task not found');
    return task;
  } catch (error) {
    if (error instanceof GoalsTasksServiceError) throw error;
    const conflict = mapGeneratedStateError(error);
    if (conflict) throw new GoalsTasksServiceError(409, conflict.code, conflict.error);
    throw error;
  }
}

export async function blockTaskForProject<T>(
  dependencies: {
    sessionBelongsToProject: (projectId: string, sessionId: string) => Promise<boolean>;
    transitionTask(input: {
      projectId: string;
      taskId: string;
      status: 'blocked';
      expectedClaimSessionId: string;
      result: { blocker: string };
      now: Date;
    }): Promise<T | null>;
  },
  input: {
    projectId: string;
    taskId: string;
    blocker: string;
    sessionId: string;
    authenticatedSessionId?: string | null;
    now: Date;
  },
): Promise<T> {
  const blocker = typeof input.blocker === 'string' ? input.blocker.trim() : '';
  if (!blocker) {
    throw new GoalsTasksServiceError(400, 'blocker_required', 'blocker must be non-empty');
  }
  assertSessionIdentity(input);
  await assertProjectSession(dependencies, input);
  try {
    const task = await dependencies.transitionTask({
      projectId: input.projectId,
      taskId: input.taskId,
      status: 'blocked',
      expectedClaimSessionId: input.sessionId,
      result: { blocker },
      now: input.now,
    });
    if (!task) throw new GoalsTasksServiceError(404, 'task_not_found', 'Task not found');
    return task;
  } catch (error) {
    if (error instanceof GoalsTasksServiceError) throw error;
    const conflict = mapGeneratedStateError(error);
    if (conflict) throw new GoalsTasksServiceError(409, conflict.code, conflict.error);
    throw error;
  }
}

export async function resolveObservationSessionId(
  dependencies: {
    sessionBelongsToProject(projectId: string, sessionId: string): Promise<boolean>;
  },
  input: {
    projectId: string;
    requestedSessionId?: string | null;
    authenticatedSessionId?: string | null;
  },
): Promise<string | null> {
  const authenticated = input.authenticatedSessionId ?? null;
  if (authenticated) {
    if (input.requestedSessionId != null && input.requestedSessionId !== authenticated) {
      throw new GoalsTasksServiceError(
        403,
        'session_identity_mismatch',
        'A project session can record observations only as its own session_id',
      );
    }
    if (!(await dependencies.sessionBelongsToProject(input.projectId, authenticated))) {
      throw new GoalsTasksServiceError(400, 'session_not_in_project', 'authenticated session must belong to this project');
    }
    return authenticated;
  }
  if (input.requestedSessionId == null) return null;
  if (!(await dependencies.sessionBelongsToProject(input.projectId, input.requestedSessionId))) {
    throw new GoalsTasksServiceError(400, 'session_not_in_project', 'session_id must belong to this project');
  }
  return input.requestedSessionId;
}

function assertSessionIdentity(input: {
  sessionId: string;
  authenticatedSessionId?: string | null;
}): void {
  if (input.authenticatedSessionId != null && input.authenticatedSessionId !== input.sessionId) {
    throw new GoalsTasksServiceError(
      403,
      'session_identity_mismatch',
      'A project session can coordinate tasks only as its own session_id',
    );
  }
}

async function assertProjectSession(
  dependencies: {
    sessionBelongsToProject: (projectId: string, sessionId: string) => Promise<boolean>;
  },
  input: { projectId: string; sessionId: string },
): Promise<void> {
  if (!(await dependencies.sessionBelongsToProject(input.projectId, input.sessionId))) {
    throw new GoalsTasksServiceError(
      400,
      'session_not_in_project',
      'session_id must belong to this project',
    );
  }
}
