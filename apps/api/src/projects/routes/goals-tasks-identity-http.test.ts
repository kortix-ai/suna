import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
let authType: 'pat' | 'supabase' = 'pat';
let authenticatedSessionId: string | null = 'authenticated-session';

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
    result: {},
    createdAt: now,
    updatedAt: now,
  };
}

const claimTask = mock(async () => task('doing'));
const transitionTask = mock(async (input: { status: 'done' | 'blocked' }) => task(input.status));
const realStore = await import('../generated-state-store');
mock.module('../generated-state-store', () => ({
  ...realStore,
  claimProjectTask: claimTask,
  transitionProjectTask: transitionTask,
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

mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: {
      projectId: PROJECT_ID,
      accountId: '44444444-4444-4444-8444-444444444444',
      manifestPath: 'kortix.yaml',
    },
  }),
  assertProjectCapability: async () => {},
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
  claimTask.mockClear();
  transitionTask.mockClear();
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
