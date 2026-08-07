import { describe, expect, test } from 'bun:test';
import {
  type TaskGitWriteAdmission,
  TaskGitWriteNotAdmittedError,
  runTaskWorkerGitWrite,
} from './task-write-fence';

const BASE = new Date('2026-08-07T03:30:00.000Z');
const admission = (requestId: string, leaseMs = 1_000): TaskGitWriteAdmission => ({
  taskId: 'task-1',
  requestId,
  abortAt: new Date(BASE.getTime() + leaseMs),
  leaseExpiresAt: new Date(BASE.getTime() + leaseMs + 30_000),
});

describe('task worker receive-pack fence', () => {
  test('settles the exact admitted request on success', async () => {
    const settled: string[] = [];
    const result = await runTaskWorkerGitWrite({
      projectId: 'project-1',
      workerSessionId: 'worker-1',
      requestId: 'request-1',
      now: () => BASE,
      acquire: async (input) => admission(input.requestId),
      settle: async (input) => {
        settled.push(input.requestId);
        return true;
      },
      execute: async (signal) => {
        expect(signal.aborted).toBe(false);
        return 'ok';
      },
    });

    expect(result).toBe('ok');
    expect(settled).toEqual(['request-1']);
  });

  test('keeps the durable request live when upstream fails', async () => {
    const settled: string[] = [];
    await expect(
      runTaskWorkerGitWrite({
        projectId: 'project-1',
        workerSessionId: 'worker-1',
        requestId: 'request-error',
        now: () => BASE,
        acquire: async (input) => admission(input.requestId),
        settle: async (input) => {
          settled.push(input.requestId);
          return true;
        },
        execute: async () => {
          throw new Error('upstream failed');
        },
      }),
    ).rejects.toThrow('upstream failed');
    expect(settled).toEqual([]);
  });

  test('aborts before the task deadline and leaves settlement to reconciliation', async () => {
    const settled: string[] = [];
    const started = Date.now();
    await expect(
      runTaskWorkerGitWrite({
        projectId: 'project-1',
        workerSessionId: 'worker-1',
        requestId: 'request-deadline',
        acquire: async (input) => ({
          ...admission(input.requestId),
          abortAt: new Date(Date.now() + 20),
          leaseExpiresAt: new Date(Date.now() + 50),
        }),
        settle: async (input) => {
          settled.push(input.requestId);
          return true;
        },
        execute: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }),
    ).rejects.toThrow('task worker Git write safety deadline reached');
    expect(Date.now() - started).toBeLessThan(500);
    expect(settled).toEqual([]);
  });

  test('confirms no mutation when admission occurs after the abort window', async () => {
    const settled: string[] = [];
    let executed = false;
    await expect(
      runTaskWorkerGitWrite({
        projectId: 'project-1',
        workerSessionId: 'worker-1',
        requestId: 'request-late',
        now: () => BASE,
        acquire: async (input) => ({ ...admission(input.requestId), abortAt: BASE }),
        settle: async (input) => {
          settled.push(input.requestId);
          return true;
        },
        execute: async () => {
          executed = true;
          return 'unsafe';
        },
      }),
    ).rejects.toBeInstanceOf(TaskGitWriteNotAdmittedError);
    expect(executed).toBe(false);
    expect(settled).toEqual(['request-late']);
  });

  test('does not execute upstream when PostgreSQL denies admission', async () => {
    let executed = false;
    await expect(
      runTaskWorkerGitWrite({
        projectId: 'project-1',
        workerSessionId: 'worker-1',
        requestId: 'request-denied',
        now: () => BASE,
        acquire: async () => null,
        settle: async () => true,
        execute: async () => {
          executed = true;
        },
      }),
    ).rejects.toBeInstanceOf(TaskGitWriteNotAdmittedError);
    expect(executed).toBe(false);
  });
});
