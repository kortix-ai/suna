/**
 * Durable task-worker fence around one raw Git receive-pack request.
 *
 * PostgreSQL owns admission. This module owns only the upstream abort timer and
 * matching settlement. It deliberately contains no process-local lock: another
 * API replica sees the same task-row lease.
 */
export interface TaskGitWriteAdmission {
  taskId: string;
  requestId: string;
  leaseExpiresAt: Date;
}

export class TaskGitWriteNotAdmittedError extends Error {
  readonly code = 'TASK_GIT_WRITE_NOT_ADMITTED' as const;

  constructor(readonly workerSessionId: string) {
    super(`worker session ${workerSessionId} has no available task Git write lease`);
    this.name = 'TaskGitWriteNotAdmittedError';
  }
}

export async function runTaskWorkerGitWrite<T>(input: {
  projectId: string;
  workerSessionId: string;
  requestId: string;
  now?: () => Date;
  acquire: (input: {
    projectId: string;
    workerSessionId: string;
    requestId: string;
    now: Date;
  }) => Promise<TaskGitWriteAdmission | null>;
  settle: (input: {
    projectId: string;
    workerSessionId: string;
    requestId: string;
    now: Date;
  }) => Promise<boolean>;
  execute: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const now = input.now ?? (() => new Date());
  const admitted = await input.acquire({
    projectId: input.projectId,
    workerSessionId: input.workerSessionId,
    requestId: input.requestId,
    now: now(),
  });
  if (!admitted) throw new TaskGitWriteNotAdmittedError(input.workerSessionId);

  const remainingMs = admitted.leaseExpiresAt.getTime() - now().getTime();
  if (remainingMs <= 0) {
    await input.settle({
      projectId: input.projectId,
      workerSessionId: input.workerSessionId,
      requestId: input.requestId,
      now: now(),
    });
    throw new TaskGitWriteNotAdmittedError(input.workerSessionId);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('task worker Git write deadline reached'));
  }, remainingMs);

  try {
    return await input.execute(controller.signal);
  } finally {
    clearTimeout(timeout);
    // The database predicate includes request_id. A late response can never
    // clear the fence acquired by a newer request after this lease expires.
    await input.settle({
      projectId: input.projectId,
      workerSessionId: input.workerSessionId,
      requestId: input.requestId,
      now: now(),
    });
  }
}
