import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  blockProjectTask,
  claimProjectTask,
  completeProjectTask,
  createProjectTask,
  getProjectTask,
  listProjectTasks,
  recordProjectTaskProgress,
  registerProjectTaskWorker,
  settleNoProgressProjectTask,
} from './tasks';

let calls: Array<{ url: string; method: string; body?: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    });
    return new Response(JSON.stringify({ tasks: [], task: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
const last = () => calls[calls.length - 1];

test('task reads bind identifiers and encode list filters', async () => {
  await listProjectTasks('project-1', {
    goal_slug: 'ship kernel',
    statuses: ['todo', 'doing'],
    limit: 25,
  });
  expect(last().url).toBe(
    'http://test.local/projects/project-1/tasks?goal_slug=ship+kernel&status=todo&status=doing&limit=25',
  );

  await getProjectTask('project-1', 'task/one');
  expect(last().url).toBe('http://test.local/projects/project-1/tasks/task%2Fone');
});

test('task creation carries the idempotent origin fingerprint', async () => {
  await createProjectTask('project-1', {
    goal_slug: 'ship-kernel',
    title: 'Verify API',
    origin: 'meta',
    origin_fingerprint: 'ship-kernel:verify-api:v1',
    blocked_by: [],
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks',
    method: 'POST',
    body: {
      goal_slug: 'ship-kernel',
      title: 'Verify API',
      origin: 'meta',
      origin_fingerprint: 'ship-kernel:verify-api:v1',
      blocked_by: [],
    },
  });
});

test('task claim and terminal transitions carry session ownership and evidence', async () => {
  await claimProjectTask('project-1', 'task-1', {
    session_id: 'session-1',
    lease_seconds: 900,
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/claim',
    method: 'POST',
    body: { session_id: 'session-1', lease_seconds: 900 },
  });

  await completeProjectTask('project-1', 'task-1', {
    session_id: 'session-1',
    evidence: [{ ref: 'ke2e://run/123', summary: '14 flows passed' }],
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/done',
    method: 'POST',
    body: {
      session_id: 'session-1',
      evidence: [{ ref: 'ke2e://run/123', summary: '14 flows passed' }],
    },
  });

  await blockProjectTask('project-1', 'task-2', {
    session_id: 'session-2',
    blocker: 'Human approval is required',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-2/block',
    method: 'POST',
    body: { session_id: 'session-2', blocker: 'Human approval is required' },
  });
});


test('worker registration, progress, and no-progress use separate durable contracts', async () => {
  await registerProjectTaskWorker('project-1', 'task-1', {
    session_id: 'coordinator-session',
    worker_session_id: 'worker-session',
    prompt: 'Implement and verify the bounded task.',
    contract: {
      max_wall_seconds: 900,
      max_tokens: 50_000,
      max_cost_usd: 2.5,
      max_iterations: 8,
    },
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/worker', method: 'POST',
    body: expect.objectContaining({ worker_session_id: 'worker-session', prompt: 'Implement and verify the bounded task.' }),
  });

  await recordProjectTaskProgress('project-1', 'task-1', {
    session_id: 'coordinator-session', worker_session_id: 'worker-session', ref: 'commit:abc123',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/progress', method: 'POST',
    body: { session_id: 'coordinator-session', worker_session_id: 'worker-session', ref: 'commit:abc123' },
  });

  await settleNoProgressProjectTask('project-1', 'task-1', {
    session_id: 'coordinator-session', worker_session_id: 'worker-session', settlement_id: 'settlement-1',
    reason: 'Worker settled without verifier evidence or a delivered blocker',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/no-progress', method: 'POST',
    body: {
      session_id: 'coordinator-session', worker_session_id: 'worker-session', settlement_id: 'settlement-1',
      reason: 'Worker settled without verifier evidence or a delivered blocker',
    },
  });
});
