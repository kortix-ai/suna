import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
let authType: 'pat' | 'supabase' = 'pat';
let authenticatedSessionId: string | null = 'authenticated-session';
let workerState: 'not_worker' | 'spawned_unbound' | 'bound' = 'not_worker';

function task(status: 'doing' | 'done' | 'blocked' = 'doing') {
  const now = new Date('2026-08-07T12:00:00.000Z');
  return {
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    goalSlug: 'ship-kernel',
    parentId: null,
    title: 'Identity-bound task',
    body: '',
    status,
    priority: 0,
    assigneeAgent: null,
    assigneeUserId: null,
    blockedBy: [],
    origin: 'test',
    originFingerprint: null,
    claimSessionId: status === 'doing' ? 'authenticated-session' : null,
    claimedAt: status === 'doing' ? now : null,
    claimExpiresAt: status === 'doing' ? new Date('2026-08-07T12:15:00.000Z') : null,
    livenessWorkerSessionId: null,
    livenessCoordinatorSessionId: null,
    livenessWorkerContract: null,
    livenessStartedAt: null,
    livenessDeadlineAt: null,
    livenessIterationsAdmitted: 0,
    noProgressSettlements: 0,
    continuationConsumedAt: null,
    lastProgressAt: null,
    lastProgressRef: null,
    lastNoProgressSettlementId: null,
    lastNoProgressAction: null,
    lastNoProgressCommandId: null,
    escalatedAt: null,
    livenessBlocker: null,
    result: {},
    createdAt: now,
    updatedAt: now,
  };
}

const claimTask = mock(async () => task('doing'));
const transitionTask = mock(async (input: { status: 'done' | 'blocked' }) => task(input.status));
const recordObservation = mock(async (input: { sessionId?: string | null }) => ({
  observationId: '55555555-5555-4555-8555-555555555555',
  projectId: PROJECT_ID,
  goalSlug: 'ship-kernel',
  evaluationId: '66666666-6666-4666-8666-666666666666',
  metric: 'latency',
  value: 1,
  source: 'test',
  sessionId: input.sessionId ?? null,
  observedAt: new Date('2026-08-07T12:00:00.000Z'),
  createdAt: new Date('2026-08-07T12:00:00.000Z'),
}));
const realStore = await import('../generated-state-store');
mock.module('../generated-state-store', () => ({
  ...realStore,
  claimProjectTask: claimTask,
  transitionProjectTask: transitionTask,
  recordProjectGoalObservation: recordObservation,
  getProjectGoalEvaluationHealthRows: async () => [
    {
      evaluationId: '66666666-6666-4666-8666-666666666666',
      state: 'fired',
      observations: { latency: 1 },
    },
  ],
  projectTaskWorkerAdmissionState: async () => workerState,
  getProjectTaskWorkerBinding: async () =>
    workerState === 'bound' ? { taskId: TASK_ID, status: 'doing' as const } : null,
}));

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ sessionId: 'existing-session' }] }),
      }),
    }),
  },
}));

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: {
      projectId: PROJECT_ID,
      accountId: '44444444-4444-4444-8444-444444444444',
      manifestPath: 'kortix.yaml',
    },
  }),
  assertProjectCapability: async () => {},
  resolveSessionOwnerIdentities: async () => new Map(),
}));

mock.module('../lib/git', () => ({
  withProjectGitAuth: async <T>(row: T) => row,
}));

const realTriggers = await import('../triggers');
mock.module('../triggers', () => ({
  ...realTriggers,
  readManifest: async () => ({
    schemaVersion: 2,
    format: 'yaml' as const,
    path: 'kortix.yaml',
    raw: {
      goals: [
        {
          slug: 'ship-kernel',
          title: 'Ship kernel',
          done_when: 'done',
          status: 'active',
          metrics: [{ name: 'latency', direction: 'decrease', target: 1, unit: 'ms' }],
        },
      ],
    },
  }),
  extractGoals: () => ({
    specs: [
      {
        slug: 'ship-kernel',
        path: 'goals/ship-kernel.md',
        title: 'Ship kernel',
        doneWhen: 'done',
        status: 'active',
        pushCron: null,
        timezone: 'UTC',
        agent: null,
        metrics: [{ name: 'latency', direction: 'decrease', target: 1, unit: 'ms' }],
      },
    ],
    errors: [],
  }),
  extractTriggers: () => ({ specs: [], errors: [] }),
}));

const { projectsApp } = await import('../lib/app');
projectsApp.use('*', async (c, next) => {
  c.set('authType', authType);
  c.set('userId', USER_ID);
  if (authenticatedSessionId != null) c.set('sessionId', authenticatedSessionId);
  await next();
});
await import('./goals-tasks');

function post(suffix: 'claim' | 'done' | 'block', sessionId: string) {
  const extra =
    suffix === 'claim'
      ? { lease_seconds: 300 }
      : suffix === 'done'
        ? { evidence: [{ ref: 'proof' }] }
        : { blocker: 'waiting' };
  return projectsApp.request(`/${PROJECT_ID}/tasks/${TASK_ID}/${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...extra }),
  });
}

beforeEach(() => {
  authType = 'pat';
  authenticatedSessionId = 'authenticated-session';
  workerState = 'not_worker';
  claimTask.mockClear();
  transitionTask.mockClear();
  recordObservation.mockClear();
});

describe('goal health HTTP contract', () => {
  test('returns authenticated health while preserving Git-authored desired status', async () => {
    const response = await projectsApp.request(`/${PROJECT_ID}/goals/ship-kernel/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      health: {
        goal_slug: 'ship-kernel',
        desired_status: 'active',
        health_status: 'measuring',
        metrics: [
          {
            metric: 'latency',
            status: 'measuring',
            evaluation_id: '66666666-6666-4666-8666-666666666666',
            evaluation_state: 'fired',
            observation_value: 1,
          },
        ],
      },
    });
  });
});

describe('task transition HTTP identity binding', () => {
  for (const suffix of ['claim', 'done', 'block'] as const) {
    test(`a project-session PAT cannot impersonate another session on ${suffix}`, async () => {
      const response = await post(suffix, 'impersonated-session');
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'session_identity_mismatch' });
    });
  }

  test('a human PAT can coordinate an existing project session', async () => {
    authenticatedSessionId = null;
    const response = await post('claim', 'existing-session');
    expect(response.status).toBe(200);
    expect(claimTask).toHaveBeenCalledTimes(1);
  });

  test('a Supabase auth session is not mistaken for a project session', async () => {
    authType = 'supabase';
    authenticatedSessionId = 'supabase-browser-session';
    const response = await post('claim', 'existing-session');
    expect(response.status).toBe(200);
    expect(claimTask).toHaveBeenCalledTimes(1);
  });
});

describe('goal observation HTTP identity binding', () => {
  test('a project-session principal cannot attribute an observation to another session', async () => {
    const response = await projectsApp.request(`/${PROJECT_ID}/goals/ship-kernel/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        evaluation_id: '66666666-6666-4666-8666-666666666666',
        metric: 'latency',
        value: 1,
        source: 'test',
        session_id: 'impersonated-session',
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'session_identity_mismatch' });
  });
});

describe('worker task-control confinement', () => {
  test('a spawned-unbound worker cannot claim task authority', async () => {
    workerState = 'spawned_unbound';
    const response = await post('claim', 'authenticated-session');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'task_worker_control_denied' });
    expect(claimTask).toHaveBeenCalledTimes(0);
  });

  test('a bound worker cannot create another task', async () => {
    workerState = 'bound';
    const response = await projectsApp.request(`/${PROJECT_ID}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal_slug: 'ship-kernel',
        title: 'Unauthorized coordination',
        origin: 'worker',
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'task_worker_control_denied' });
  });

  test('a bound worker cannot write goal observations', async () => {
    workerState = 'bound';
    const response = await projectsApp.request(`/${PROJECT_ID}/goals/ship-kernel/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        evaluation_id: '66666666-6666-4666-8666-666666666666',
        metric: 'latency',
        value: 1,
        source: 'test',
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'task_worker_control_denied' });
    expect(recordObservation).toHaveBeenCalledTimes(0);
  });
});
