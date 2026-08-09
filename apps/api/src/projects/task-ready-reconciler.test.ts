import { describe, expect, test } from 'bun:test';
import {
  type ReadyTaskCandidate,
  buildReadyTaskCreateRequest,
  reconcileReadyProjectTasks,
} from './task-ready-reconciler';

const PROJECT_ID = '00000000-0000-4000-a000-00000000d001';
const ACCOUNT_ID = '00000000-0000-4000-a000-00000000d002';

function candidate(
  taskId: string,
  overrides: Partial<ReadyTaskCandidate> = {},
): ReadyTaskCandidate {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    projectMetadata: { experimental: { agi: true } },
    taskId,
    title: `Task ${taskId}`,
    status: 'todo',
    priority: 0,
    createdAt: new Date('2026-08-09T12:00:00.000Z'),
    updatedAt: new Date('2026-08-09T12:00:00.000Z'),
    claimSessionId: null,
    dependenciesReady: true,
    assigneeAgent: null,
    assigneeUserId: null,
    ...overrides,
  };
}

describe('ready task reconciler', () => {
  test('does not select or queue work when agi is disabled', async () => {
    let enqueueCalls = 0;
    const result = await reconcileReadyProjectTasks({
      listCandidates: async () => [
        candidate('00000000-0000-4000-a000-00000000d101', {
          projectMetadata: { experimental: { agi: false } },
        }),
      ],
      enqueue: async () => {
        enqueueCalls += 1;
        return { commandId: 'unexpected', existing: false };
      },
    });

    expect(result).toEqual({
      scanned: 1,
      eligible: 0,
      queued: 0,
      deduped: 0,
      commandIds: [],
    });
    expect(enqueueCalls).toBe(0);
  });

  test('queues one deterministic AGI create command with a task post-create action', async () => {
    const task = candidate('00000000-0000-4000-a000-00000000d102');
    const requests: ReturnType<typeof buildReadyTaskCreateRequest>[] = [];
    const result = await reconcileReadyProjectTasks({
      listCandidates: async () => [task],
      enqueue: async (request) => {
        requests.push(request);
        return { commandId: 'command-1', existing: false };
      },
    });

    expect(result).toEqual({
      scanned: 1,
      eligible: 1,
      queued: 1,
      deduped: 0,
      commandIds: ['command-1'],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.idempotencyKey).toBe(
      `task-ready:${PROJECT_ID}:${task.taskId}:${task.updatedAt.getTime()}`,
    );
    expect(requests[0]?.payload.body.agent_name).toBe('agi');
    expect(requests[0]?.payload.postCreate).toEqual([
      expect.objectContaining({
        type: 'claim_ready_task',
        taskId: task.taskId,
      }),
    ]);
  });

  test('a duplicate sweep converges on the same create command', async () => {
    const task = candidate('00000000-0000-4000-a000-00000000d103');
    const commands = new Map<string, string>();
    const enqueue = async (request: ReturnType<typeof buildReadyTaskCreateRequest>) => {
      const existing = commands.get(request.idempotencyKey);
      if (existing) return { commandId: existing, existing: true };
      commands.set(request.idempotencyKey, 'command-stable');
      return { commandId: 'command-stable', existing: false };
    };
    const first = await reconcileReadyProjectTasks({
      listCandidates: async () => [task],
      enqueue,
    });
    const replay = await reconcileReadyProjectTasks({
      listCandidates: async () => [task],
      enqueue,
    });

    expect(first.commandIds).toEqual(['command-stable']);
    expect(replay.commandIds).toEqual(['command-stable']);
    expect(first.queued).toBe(1);
    expect(replay.deduped).toBe(1);
    expect(commands.size).toBe(1);
  });

  test('a later todo generation receives a new create command', () => {
    const first = candidate('00000000-0000-4000-a000-00000000d108');
    const replay = candidate(first.taskId, {
      updatedAt: new Date(first.updatedAt.getTime() + 1_000),
    });

    expect(buildReadyTaskCreateRequest(replay).idempotencyKey).not.toBe(
      buildReadyTaskCreateRequest(first).idempotencyKey,
    );
  });

  test('does not queue a dependency-blocked task', async () => {
    let enqueueCalls = 0;
    const result = await reconcileReadyProjectTasks({
      listCandidates: async () => [
        candidate('00000000-0000-4000-a000-00000000d104', {
          dependenciesReady: false,
        }),
      ],
      enqueue: async () => {
        enqueueCalls += 1;
        return { commandId: 'unexpected', existing: false };
      },
    });
    expect(result.eligible).toBe(0);
    expect(enqueueCalls).toBe(0);
  });

  test('keeps backlog tasks unclaimed until they move to todo', async () => {
    let enqueueCalls = 0;
    const result = await reconcileReadyProjectTasks({
      listCandidates: async () => [
        candidate('00000000-0000-4000-a000-00000000d108', {
          status: 'backlog',
        }),
      ],
      enqueue: async () => {
        enqueueCalls += 1;
        return { commandId: 'unexpected', existing: false };
      },
    });

    expect(result.eligible).toBe(0);
    expect(enqueueCalls).toBe(0);
  });

  test('orders concurrent candidates deterministically and applies the bounded limit', async () => {
    const oldest = candidate('00000000-0000-4000-a000-00000000d105', {
      priority: 5,
      createdAt: new Date('2026-08-09T10:00:00.000Z'),
    });
    const lexicalFirst = candidate('00000000-0000-4000-a000-00000000d106', {
      priority: 5,
      createdAt: new Date('2026-08-09T11:00:00.000Z'),
    });
    const lowPriority = candidate('00000000-0000-4000-a000-00000000d107', {
      priority: 1,
    });
    const queuedTaskIds: string[] = [];
    const result = await reconcileReadyProjectTasks({
      limit: 2,
      listCandidates: async () => [lowPriority, lexicalFirst, oldest],
      enqueue: async (request) => {
        const action = request.payload.postCreate?.[0];
        if (action?.type === 'claim_ready_task') queuedTaskIds.push(action.taskId);
        return {
          commandId: `command-${queuedTaskIds.length}`,
          existing: false,
        };
      },
    });

    expect(result.eligible).toBe(2);
    expect(result.queued).toBe(2);
    expect(queuedTaskIds).toEqual([oldest.taskId, lexicalFirst.taskId]);
  });
});
