import { describe, expect, test } from 'bun:test';
import { completeTaskForProject } from './goals-tasks-service';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-07T12:00:00.000Z');

function input(evidence = [{ ref: 'verifier://report/42' }]) {
  return {
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    sessionId: 'coordinator-session',
    authenticatedSessionId: 'coordinator-session',
    evidence,
    now: NOW,
  };
}

function dependencies(
  evidenceState: {
    livenessCoordinatorSessionId: string | null;
    livenessWorkerSessionId: string | null;
    lastProgressRef: string | null;
  } | null,
) {
  let transitionInput: unknown;
  return {
    dependencies: {
      sessionBelongsToProject: async () => true,
      loadTaskEvidence: async () =>
        evidenceState && {
          intent: '',
          constraints: [],
          outOfScope: [],
          contractRevision: 1,
          controlPlaneVersion: null,
          verificationRequirements: [],
          reviewPolicy: { mode: 'auto' as const },
          ...evidenceState,
        },
      transitionTask: async (value: unknown) => {
        transitionInput = value;
        return { taskId: TASK_ID };
      },
    },
    transitionInput: () => transitionInput,
  };
}

describe('task completion evidence provenance', () => {
  test('preserves explicit evidence completion for a task without a liveness worker', async () => {
    const setup = dependencies({
      livenessCoordinatorSessionId: null,
      livenessWorkerSessionId: null,
      lastProgressRef: null,
    });

    await expect(completeTaskForProject(setup.dependencies, input())).resolves.toEqual({
      taskId: TASK_ID,
    });
    expect(setup.transitionInput()).toMatchObject({
      status: 'done',
      result: { evidence: [{ ref: 'verifier://report/42' }] },
    });
    const transition = setup.transitionInput() as {
      result: { verifier?: unknown };
    };
    expect(transition.result.verifier).toBeUndefined();
  });

  test('rejects completion without server-recorded progress from a distinct bound worker', async () => {
    const setup = dependencies({
      livenessCoordinatorSessionId: 'coordinator-session',
      livenessWorkerSessionId: 'worker-session',
      lastProgressRef: null,
    });

    await expect(completeTaskForProject(setup.dependencies, input())).rejects.toMatchObject({
      status: 400,
      code: 'verified_progress_required',
    });
    expect(setup.transitionInput()).toBeUndefined();
  });

  test('rejects completion when cited evidence omits the recorded progress ref', async () => {
    const setup = dependencies({
      livenessCoordinatorSessionId: 'coordinator-session',
      livenessWorkerSessionId: 'worker-session',
      lastProgressRef: 'verifier://report/42',
    });

    await expect(
      completeTaskForProject(setup.dependencies, input([{ ref: 'worker://claim/99' }])),
    ).rejects.toMatchObject({
      status: 400,
      code: 'verified_progress_required',
    });
    expect(setup.transitionInput()).toBeUndefined();
  });

  test('stamps server-owned coordinator and worker provenance on the done transition', async () => {
    const setup = dependencies({
      livenessCoordinatorSessionId: 'coordinator-session',
      livenessWorkerSessionId: 'worker-session',
      lastProgressRef: 'verifier://report/42',
    });

    await expect(completeTaskForProject(setup.dependencies, input())).resolves.toEqual({
      taskId: TASK_ID,
    });
    expect(setup.transitionInput()).toMatchObject({
      status: 'done',
      expectedClaimSessionId: 'coordinator-session',
      result: {
        evidence: [{ ref: 'verifier://report/42' }],
        verifier: {
          coordinator_session_id: 'coordinator-session',
          worker_session_id: 'worker-session',
          progress_ref: 'verifier://report/42',
          verified_at: NOW.toISOString(),
        },
      },
    });
  });
});
