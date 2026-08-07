import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type GoalsTasksServiceError,
  blockTaskForProject,
  claimTaskForProject,
  completeTaskForProject,
  mapGeneratedStateError,
  resolveObservationSessionId,
} from './goals-tasks-service';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';

describe('goals/tasks route wiring', () => {
  test('registers the route module immediately after r11', () => {
    const index = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8');
    expect(index).toContain("import './routes/r11';\nimport './routes/goals-tasks';");

    const route = readFileSync(join(import.meta.dir, 'goals-tasks.ts'), 'utf8');
    for (const path of [
      '/{projectId}/goals',
      '/{projectId}/goals/{slug}',
      '/{projectId}/goals/{slug}/push',
      '/{projectId}/goals/{slug}/observations',
      '/{projectId}/tasks',
      '/{projectId}/tasks/{taskId}',
      '/{projectId}/tasks/{taskId}/claim',
      '/{projectId}/tasks/{taskId}/done',
      '/{projectId}/tasks/{taskId}/block',
      '/{projectId}/tasks/{taskId}/worker',
      '/{projectId}/tasks/{taskId}/progress',
      '/{projectId}/tasks/{taskId}/no-progress',
    ]) {
      expect(route).toContain(`path: '${path}'`);
    }
  });
});

describe('goals/tasks service boundaries', () => {
  test('rejects a task claim when the session belongs to another project', async () => {
    let claimCalls = 0;
    await expect(
      claimTaskForProject(
        {
          sessionBelongsToProject: async () => false,
          claimTask: async () => {
            claimCalls += 1;
            return { taskId: TASK_ID };
          },
        },
        {
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          sessionId: 'session-from-another-project',
          leaseSeconds: 300,
          now: new Date('2026-08-07T12:00:00.000Z'),
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: 'session_not_in_project',
    } satisfies Partial<GoalsTasksServiceError>);
    expect(claimCalls).toBe(0);
  });

  test('binds claim, done, and block session_id to an authenticated project session', async () => {
    const dependencies = {
      sessionBelongsToProject: async () => true,
      claimTask: async () => ({ taskId: TASK_ID }),
      loadTaskEvidence: async () => null,
      transitionTask: async () => ({ taskId: TASK_ID }),
    };
    const identity = {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      sessionId: 'impersonated-session',
      authenticatedSessionId: 'authenticated-session',
      now: new Date('2026-08-07T12:00:00.000Z'),
    };

    await expect(
      claimTaskForProject(dependencies, { ...identity, leaseSeconds: 300 }),
    ).rejects.toMatchObject({ status: 403, code: 'session_identity_mismatch' });
    await expect(
      completeTaskForProject(dependencies, {
        ...identity,
        evidence: [{ ref: 'proof' }],
      }),
    ).rejects.toMatchObject({ status: 403, code: 'session_identity_mismatch' });
    await expect(
      blockTaskForProject(dependencies, { ...identity, blocker: 'blocked' }),
    ).rejects.toMatchObject({ status: 403, code: 'session_identity_mismatch' });
  });

  test('allows an unbound human JWT or PAT to coordinate an existing project session', async () => {
    const claim = await claimTaskForProject(
      {
        sessionBelongsToProject: async () => true,
        claimTask: async (input) => input,
      },
      {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: 'coordinated-session',
        authenticatedSessionId: null,
        leaseSeconds: 300,
        now: new Date('2026-08-07T12:00:00.000Z'),
      },
    );
    expect(claim.sessionId).toBe('coordinated-session');
  });

  test('refuses done without cited evidence before calling the store', async () => {
    let transitionCalls = 0;
    await expect(
      completeTaskForProject(
        {
          sessionBelongsToProject: async () => true,
          loadTaskEvidence: async () => null,
          transitionTask: async () => {
            transitionCalls += 1;
            return { taskId: TASK_ID };
          },
        },
        {
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          evidence: [],
          sessionId: 'session-1',
          now: new Date('2026-08-07T12:00:00.000Z'),
        },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'evidence_required' });
    expect(transitionCalls).toBe(0);
  });

  test('maps live claim and transition conflicts to HTTP 409', () => {
    for (const code of ['TASK_CLAIM_CONFLICT', 'TASK_TRANSITION_CONFLICT']) {
      expect(mapGeneratedStateError(Object.assign(new Error('claimed'), { code }))).toEqual({
        status: 409,
        code: code.toLowerCase(),
        error: 'claimed',
      });
    }
    expect(mapGeneratedStateError(new Error('other'))).toBeNull();
  });
});


describe('goal observation session attribution', () => {
  test('project-session principals default to themselves and cannot cite another session', async () => {
    const belongs = mock(async () => true);
    await expect(resolveObservationSessionId(
      { sessionBelongsToProject: belongs },
      { projectId: PROJECT_ID, authenticatedSessionId: 'session-a' },
    )).resolves.toBe('session-a');
    await expect(resolveObservationSessionId(
      { sessionBelongsToProject: belongs },
      { projectId: PROJECT_ID, authenticatedSessionId: 'session-a', requestedSessionId: 'session-b' },
    )).rejects.toMatchObject({ status: 403, code: 'session_identity_mismatch' });
  });

  test('human callers can cite only an existing project worker session', async () => {
    await expect(resolveObservationSessionId(
      { sessionBelongsToProject: async () => true },
      { projectId: PROJECT_ID, requestedSessionId: 'worker-session' },
    )).resolves.toBe('worker-session');
    await expect(resolveObservationSessionId(
      { sessionBelongsToProject: async () => false },
      { projectId: PROJECT_ID, requestedSessionId: 'foreign-session' },
    )).rejects.toMatchObject({ status: 400, code: 'session_not_in_project' });
  });
});


describe('worker contract platform ceilings', () => {
  test('accepts every exact platform maximum', async () => {
    const { WorkerContractSchema, WORKER_CONTRACT_PLATFORM_CEILINGS } =
      await import('./goals-tasks-schemas');

    expect(WorkerContractSchema.safeParse(WORKER_CONTRACT_PLATFORM_CEILINGS).success).toBe(true);
  });

  test.each([
    ['max_wall_seconds', 3_601],
    ['max_tokens', 1_000_001],
    ['max_cost_usd', 25.000_001],
    ['max_iterations', 129],
  ] as const)('rejects %s above the platform maximum', async (field, value) => {
    const { WorkerContractSchema, WORKER_CONTRACT_PLATFORM_CEILINGS } =
      await import('./goals-tasks-schemas');

    expect(WorkerContractSchema.safeParse({
      ...WORKER_CONTRACT_PLATFORM_CEILINGS,
      [field]: value,
    }).success).toBe(false);
  });
});
