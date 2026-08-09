import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  acknowledgeProjectTaskMessage,
  addProjectTaskEvidence,
  blockProjectTask,
  cancelProjectTask,
  claimProjectTask,
  completeProjectTask,
  createProjectTask,
  createProjectTaskBlocker,
  getCurrentProjectTask,
  getProjectTask,
  listProjectTaskBlockers,
  listProjectTaskEvents,
  listProjectTaskEvidence,
  listProjectTaskMessages,
  listProjectTaskRefinements,
  listProjectTaskSessionLinks,
  listProjectTasks,
  proposeProjectTaskRefinement,
  recordProjectTaskProgress,
  registerProjectTaskWorker,
  releaseProjectTaskClaim,
  requestProjectTaskCompletion,
  resolveProjectTaskBlocker,
  reviseProjectTaskContract,
  rollbackProjectTaskRefinement,
  sendProjectTaskMessage,
  settleNoProgressProjectTask,
} from './tasks';
import type { CreateProjectTaskInput, ProjectTask } from './tasks';

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

configureKortix({
  backendUrl: 'http://test.local',
  getToken: async () => 'token',
});
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
    origin: 'agi',
    origin_fingerprint: 'ship-kernel:verify-api:v1',
    blocked_by: [],
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks',
    method: 'POST',
    body: {
      goal_slug: 'ship-kernel',
      title: 'Verify API',
      origin: 'agi',
      origin_fingerprint: 'ship-kernel:verify-api:v1',
      blocked_by: [],
    },
  });
});

test('task creation can omit goal_slug', async () => {
  const input = {
    title: 'Handle support backlog',
    origin: 'human',
  } satisfies CreateProjectTaskInput;
  const goalSlug: ProjectTask['goal_slug'] = null;

  await createProjectTask('project-1', input);

  expect(goalSlug).toBeNull();
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks',
    method: 'POST',
    body: { title: 'Handle support backlog', origin: 'human' },
  });
});

test('task creation only accepts queue-entry statuses', () => {
  const valid: CreateProjectTaskInput[] = [
    { title: 'Backlog task', origin: 'human', status: 'backlog' },
    { title: 'Ready task', origin: 'human', status: 'todo' },
  ];
  expect(valid).toHaveLength(2);

  const doing: CreateProjectTaskInput = {
    title: 'Doing',
    origin: 'human',
    // @ts-expect-error A task must be claimed before it can be doing.
    status: 'doing',
  };
  const review: CreateProjectTaskInput = {
    title: 'Review',
    origin: 'human',
    // @ts-expect-error Review requires a submitted candidate.
    status: 'review',
  };
  const cancelled: CreateProjectTaskInput = {
    title: 'Cancelled',
    origin: 'human',
    // @ts-expect-error Cancellation is a transition, not an initial state.
    status: 'cancelled',
  };
  expect([doing, review, cancelled]).toHaveLength(3);
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

test('task claim release posts the coordinator session for idempotent compensation', async () => {
  await releaseProjectTaskClaim('project-1', 'task-1', {
    session_id: 'session-1',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/release-claim',
    method: 'POST',
    body: { session_id: 'session-1' },
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
    url: 'http://test.local/projects/project-1/tasks/task-1/worker',
    method: 'POST',
    body: expect.objectContaining({
      worker_session_id: 'worker-session',
      prompt: 'Implement and verify the bounded task.',
    }),
  });

  await recordProjectTaskProgress('project-1', 'task-1', {
    session_id: 'coordinator-session',
    worker_session_id: 'worker-session',
    settlement_id: '11111111-1111-4111-8111-111111111111',
    ref: 'commit:abc123',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/progress',
    method: 'POST',
    body: {
      session_id: 'coordinator-session',
      worker_session_id: 'worker-session',
      ref: 'commit:abc123',
    },
  });

  await settleNoProgressProjectTask('project-1', 'task-1', {
    session_id: 'coordinator-session',
    worker_session_id: 'worker-session',
    settlement_id: '33333333-3333-4333-8333-333333333333',
    reason: 'Worker settled without verifier evidence or a delivered blocker',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/no-progress',
    method: 'POST',
    body: {
      session_id: 'coordinator-session',
      worker_session_id: 'worker-session',
      settlement_id: '33333333-3333-4333-8333-333333333333',
      reason: 'Worker settled without verifier evidence or a delivered blocker',
    },
  });
});

test('AI coworker task control-plane methods bind every durable route', async () => {
  await getCurrentProjectTask('project-1');
  expect(last().url).toBe('http://test.local/projects/project-1/tasks/current');

  await reviseProjectTaskContract('project-1', 'task-1', {
    intent: 'Ship the verified result',
    verification_requirements: [
      {
        id: 'tests',
        kind: 'command',
        description: 'The focused suite passes',
        required: true,
      },
    ],
    review_policy: { mode: 'human' },
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/contract',
    method: 'PATCH',
  });

  await listProjectTaskEvidence('project-1', 'task-1');
  expect(last().url).toBe('http://test.local/projects/project-1/tasks/task-1/evidence');
  await addProjectTaskEvidence('project-1', 'task-1', {
    requirement_id: 'tests',
    kind: 'command',
    ref: 'command://bun-test',
    candidate_digest: 'sha256:abc',
    state: 'passed',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/evidence',
    method: 'POST',
  });
  await requestProjectTaskCompletion('project-1', 'task-1', {
    session_id: 'session-1',
    candidate_digest: 'sha256:abc',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/request-completion',
    method: 'POST',
  });

  await listProjectTaskBlockers('project-1', 'task-1');
  await createProjectTaskBlocker('project-1', 'task-1', {
    category: 'authorization',
    requested_action: 'Grant Drive access',
    target: { service: 'drive' },
    request_digest: 'drive-read',
    attempts_made: ['checked connector'],
  });
  await resolveProjectTaskBlocker('project-1', 'task-1', 'blocker-1');
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/blockers/blocker-1/resolve',
    method: 'POST',
  });

  await listProjectTaskEvents('project-1', 'task-1', 50);
  expect(last().url).toBe('http://test.local/projects/project-1/tasks/task-1/events?limit=50');
  await listProjectTaskSessionLinks('project-1', 'task-1');
  await listProjectTaskMessages('project-1', 'task-1');
  await sendProjectTaskMessage('project-1', 'task-1', {
    recipient_session_id: 'worker-1',
    type: 'request',
    body: { instruction: 'verify' },
    idempotency_key: 'verify-1',
  });
  await acknowledgeProjectTaskMessage('project-1', 'task-1', 'message-1');
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/tasks/task-1/messages/message-1/ack',
    method: 'POST',
  });

  await cancelProjectTask('project-1', 'task-1', { reason: 'Superseded' });
  await listProjectTaskRefinements('project-1');
  await proposeProjectTaskRefinement('project-1', {
    task_id: 'task-1',
    scope: 'task',
    observation: 'Require browser proof',
    base_revision: '1',
    patch: { verifier: 'browser' },
    evidence_refs: [],
  });
  await rollbackProjectTaskRefinement('project-1', 'proposal-1');
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/refinements/proposal-1/rollback',
    method: 'POST',
  });
});

test('worker registration accepts the exact platform ceilings', async () => {
  const input = {
    session_id: 'coordinator-session',
    worker_session_id: 'worker-session',
    prompt: 'Execute the bounded task.',
    contract: {
      max_wall_seconds: 3_600,
      max_tokens: 1_000_000,
      max_cost_usd: 25,
      max_iterations: 128,
    },
  };
  await registerProjectTaskWorker('project-1', 'task-1', input);
  expect(last().body).toEqual(input);
});

test.each([
  ['max_wall_seconds', 3_601, 'max_wall_seconds must be between 1 and 3600'],
  ['max_tokens', 1_000_001, 'max_tokens must be between 1 and 1000000'],
  ['max_cost_usd', 25.000_001, 'max_cost_usd must be between 0 (exclusive) and 25'],
  ['max_iterations', 129, 'max_iterations must be between 1 and 128'],
] as const)(
  'worker registration rejects %s above the platform ceiling',
  async (field, value, message) => {
    await expect(
      registerProjectTaskWorker('project-1', 'task-1', {
        session_id: 'coordinator-session',
        worker_session_id: 'worker-session',
        prompt: 'Execute the bounded task.',
        contract: {
          max_wall_seconds: 3_600,
          max_tokens: 1_000_000,
          max_cost_usd: 25,
          max_iterations: 128,
          [field]: value,
        },
      }),
    ).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  },
);
