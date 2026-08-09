import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TASK_ID = '33333333-3333-4333-8333-333333333333';
const BLOCKER_ID = '44444444-4444-4444-8444-444444444444';
const PROPOSAL_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';

let authType: 'supabase' | 'pat' | 'apiKey' | 'service_account' = 'service_account';
let sessionId: string | null = null;

const reviseContract = mock(async () => null);
const resolveBlocker = mock(async () => null);
const cancelTask = mock(async () => null);
const rollbackRefinement = mock(async () => null);
const createBlocker = mock(async () => {
  throw new Error('lineage guard did not run');
});
const proposeRefinement = mock(async () => {
  throw new Error('lineage guard did not run');
});
const requestCompletion = mock(
  async (
    _database: unknown,
    _input: { expectedClaimSessionId: string; humanReviewApproved: boolean },
  ) => cancelledTask(),
);

function cancelledTask() {
  const now = new Date('2026-08-09T14:00:00.000Z');
  return {
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    goalSlug: 'agi-v1',
    parentId: null,
    title: 'Canceled task',
    body: '',
    intent: 'Stop safely.',
    constraints: [],
    outOfScope: [],
    contractRevision: 1,
    verificationRequirements: [],
    reviewPolicy: { mode: 'auto' as const },
    status: 'cancelled' as const,
    priority: 0,
    assigneeAgent: null,
    assigneeUserId: null,
    blockedBy: [],
    origin: 'test',
    originFingerprint: null,
    claimSessionId: null,
    claimedAt: null,
    claimExpiresAt: null,
    livenessWorkerSessionId: null,
    livenessCoordinatorSessionId: null,
    livenessWorkerContract: null,
    livenessStartedAt: null,
    livenessDeadlineAt: null,
    livenessIterationsAdmitted: 0,
    livenessTurnId: null,
    noProgressSettlements: 0,
    continuationConsumedAt: null,
    lastProgressAt: null,
    lastProgressRef: null,
    lastNoProgressSettlementId: null,
    lastNoProgressAction: null,
    lastNoProgressCommandId: null,
    escalatedAt: null,
    livenessBlocker: null,
    completedAt: null,
    result: {
      canceled: { reason: 'Stop.', at: now.toISOString(), actor_id: USER_ID },
    },
    createdAt: now,
    updatedAt: now,
  };
}

const realStore = await import('../task-control-plane-store');
mock.module('../task-control-plane-store', () => ({
  ...realStore,
  reviseProjectTaskContract: reviseContract,
  resolveProjectTaskBlocker: resolveBlocker,
  cancelProjectTask: cancelTask,
  rollbackProjectTaskRefinement: rollbackRefinement,
  createProjectTaskBlocker: createBlocker,
  proposeProjectTaskRefinement: proposeRefinement,
  currentProjectTaskForSession: async () => ({ taskId: OTHER_TASK_ID }),
}));

const realGeneratedStateStore = await import('../generated-state-store');
mock.module('../generated-state-store', () => ({
  ...realGeneratedStateStore,
  requestProjectTaskCompletion: requestCompletion,
}));

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ sessionId: 'coordinator-session' }],
        }),
      }),
    }),
  },
}));

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: { accountId: '77777777-7777-4777-8777-777777777777' },
  }),
  assertProjectCapability: async () => {},
}));

const { projectsApp } = await import('../lib/app');
projectsApp.use('*', async (c, next) => {
  c.set('authType', authType);
  c.set('userId', USER_ID);
  if (sessionId) c.set('sessionId', sessionId);
  await next();
});
await import('./task-control-plane');

function jsonRequest(path: string, method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  return projectsApp.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authType = 'service_account';
  sessionId = null;
  reviseContract.mockClear();
  resolveBlocker.mockClear();
  cancelTask.mockClear();
  rollbackRefinement.mockClear();
  createBlocker.mockClear();
  proposeRefinement.mockClear();
  requestCompletion.mockClear();
});

describe('task control-plane HTTP authorization', () => {
  const humanOnlyRequests = [
    {
      name: 'contract revision',
      request: () =>
        jsonRequest(`/${PROJECT_ID}/tasks/${TASK_ID}/contract`, 'PATCH', {
          intent: 'Ship it.',
        }),
      mutation: reviseContract,
    },
    {
      name: 'blocker resolution',
      request: () =>
        jsonRequest(`/${PROJECT_ID}/tasks/${TASK_ID}/blockers/${BLOCKER_ID}/resolve`, 'POST', {}),
      mutation: resolveBlocker,
    },
    {
      name: 'task cancellation',
      request: () =>
        jsonRequest(`/${PROJECT_ID}/tasks/${TASK_ID}/cancel`, 'POST', {
          reason: 'Stop.',
        }),
      mutation: cancelTask,
    },
    {
      name: 'refinement rollback',
      request: () => jsonRequest(`/${PROJECT_ID}/refinements/${PROPOSAL_ID}/rollback`, 'POST', {}),
      mutation: rollbackRefinement,
    },
  ] as const;

  for (const example of humanOnlyRequests) {
    for (const principal of [
      {
        name: 'unbound service account',
        authType: 'service_account',
        sessionId: null,
      },
      { name: 'unbound legacy API key', authType: 'apiKey', sessionId: null },
      {
        name: 'service-account session principal',
        authType: 'service_account',
        sessionId: 'agent-session',
      },
      {
        name: 'legacy API-key session principal',
        authType: 'apiKey',
        sessionId: 'agent-session',
      },
      {
        name: 'PAT session principal',
        authType: 'pat',
        sessionId: 'agent-session',
      },
    ] as const) {
      test(`rejects ${principal.name} on ${example.name}`, async () => {
        authType = principal.authType;
        sessionId = principal.sessionId;
        const response = await example.request();
        expect(response.status).toBe(403);
        expect(example.mutation).not.toHaveBeenCalled();
      });
    }
  }

  test('rejects blocker creation outside the current task lineage', async () => {
    authType = 'pat';
    sessionId = 'outside-task-session';
    const response = await jsonRequest(`/${PROJECT_ID}/tasks/${TASK_ID}/blockers`, 'POST', {
      category: 'credential',
      requested_action: 'Grant access.',
      request_digest: 'credential-v1',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Session is outside this task lineage',
    });
    expect(createBlocker).not.toHaveBeenCalled();
  });

  test('rejects task-local refinement outside the current task lineage', async () => {
    authType = 'pat';
    sessionId = 'outside-task-session';
    const response = await jsonRequest(`/${PROJECT_ID}/refinements`, 'POST', {
      task_id: TASK_ID,
      scope: 'task',
      observation: 'The procedure needs a retry.',
      base_revision: 'v1',
      patch: { retries: 2 },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Session is outside this task lineage',
    });
    expect(proposeRefinement).not.toHaveBeenCalled();
  });

  for (const principal of [
    {
      name: 'Supabase human',
      authType: 'supabase',
      sessionId: null,
      approved: true,
    },
    { name: 'PAT human', authType: 'pat', sessionId: null, approved: true },
    {
      name: 'legacy API key',
      authType: 'apiKey',
      sessionId: null,
      approved: false,
    },
    {
      name: 'service account',
      authType: 'service_account',
      sessionId: null,
      approved: false,
    },
    {
      name: 'session-bound PAT',
      authType: 'pat',
      sessionId: 'coordinator-session',
      approved: false,
    },
  ] as const) {
    test(`sets human review approval to ${principal.approved} for ${principal.name}`, async () => {
      authType = principal.authType;
      sessionId = principal.sessionId;
      const response = await jsonRequest(
        `/${PROJECT_ID}/tasks/${TASK_ID}/request-completion`,
        'POST',
        {
          candidate_digest: 'sha256:candidate',
          ...(principal.sessionId === null ? { session_id: 'coordinator-session' } : {}),
        },
      );
      expect(response.status).toBe(200);
      expect(requestCompletion).toHaveBeenCalledTimes(1);
      expect(requestCompletion.mock.calls[0]?.[1]).toMatchObject({
        expectedClaimSessionId: 'coordinator-session',
        humanReviewApproved: principal.approved,
      });
    });
  }

  test('maps terminal blocker creation to a typed conflict', async () => {
    authType = 'pat';
    sessionId = null;
    createBlocker.mockRejectedValueOnce(
      new realStore.TaskControlPlaneConflictError('terminal tasks cannot acquire blockers'),
    );
    const response = await jsonRequest(`/${PROJECT_ID}/tasks/${TASK_ID}/blockers`, 'POST', {
      category: 'credential',
      requested_action: 'Grant access.',
      request_digest: 'terminal-task',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'terminal tasks cannot acquire blockers',
      code: 'task_control_plane_conflict',
    });
  });

  test('lets a human principal invoke the transactional cancellation path', async () => {
    authType = 'pat';
    sessionId = null;
    cancelTask.mockResolvedValueOnce(cancelledTask() as never);
    const response = await jsonRequest(`/${PROJECT_ID}/tasks/${TASK_ID}/cancel`, 'POST', {
      reason: 'Stop.',
    });
    expect(response.status).toBe(200);
    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      task: {
        status: 'cancelled',
        claim_session_id: null,
        liveness_worker_session_id: null,
      },
    });
  });

  test('maps an unsafe cancellation fence to a typed conflict', async () => {
    authType = 'supabase';
    sessionId = null;
    cancelTask.mockRejectedValueOnce(
      new realStore.TaskControlPlaneConflictError(
        'task cancellation requires settled admission and Git write fences',
      ),
    );
    const response = await jsonRequest(`/${PROJECT_ID}/tasks/${TASK_ID}/cancel`, 'POST', {
      reason: 'Stop.',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'task cancellation requires settled admission and Git write fences',
      code: 'task_control_plane_conflict',
    });
  });
});
