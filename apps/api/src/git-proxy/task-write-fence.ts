/**
 * Durable task-worker fence around one raw Git receive-pack request.
 *
 * PostgreSQL owns admission and records whether upstream completion is
 * confirmed. This module aborts before the immutable worker deadline. An abort
 * or transport failure deliberately does not settle the fence: the recurring
 * reconciler must observe the remote ref after the crash grace window.
 */
export interface TaskGitWriteAdmission {
  taskId: string;
  requestId: string;
  abortAt: Date;
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

  const remainingMs = admitted.abortAt.getTime() - now().getTime();
  if (remainingMs <= 0) {
    // No provider request started. This is a confirmed no-mutation settlement.
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
    controller.abort(new Error('task worker Git write safety deadline reached'));
  }, remainingMs);

  try {
    const result = await input.execute(controller.signal);
    // A receive-pack response proves that the server completed its ref
    // transaction. Only this path confirms settlement synchronously.
    await input.settle({
      projectId: input.projectId,
      workerSessionId: input.workerSessionId,
      requestId: input.requestId,
      now: now(),
    });
    return result;
  } finally {
    clearTimeout(timeout);
    // Do not settle on abort or rejection. Closing the client-side fetch is not
    // proof that receive-pack stopped before its compare-and-swap. The durable
    // live state remains until remote-ref reconciliation confirms settlement.
  }
}
