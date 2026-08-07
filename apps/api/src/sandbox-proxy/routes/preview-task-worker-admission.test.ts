// Every OpenCode turn-start route must fail closed for a metadata-marked child
// until registerProjectTaskWorker commits its binding. The same gate preserves
// ordinary sessions and registered doing workers, and it re-checks immediately
// before the upstream fetch to close status-transition races.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';
import * as realKortixUserContext from '../../shared/kortix-user-context';
import * as realPreviewOwnership from '../../shared/preview-ownership';

const ACTIVE_RECORD = {
  status: 'active',
  serviceKey: 'svc-key',
  sessionId: 'worker-session-1',
  projectId: 'project-1',
  accountId: 'account-1',
  externalId: 'sandbox-1',
  sandboxId: 'sandbox-1',
  agentName: 'default',
  provider: 'daytona',
};

type Admission =
  | { state: 'not_worker' }
  | { state: 'spawned_unbound' }
  | { state: 'bound'; binding: { taskId: string; status: string } };

let admissions: Admission[] = [];
let admissionCalls = 0;
let upstreamCalls = 0;

mock.module('../../config', () => ({ config: { KORTIX_ENFORCE_SESSION_AGENT_LOCK: false } }));
mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
mock.module('../../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
}));
mock.module('../../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
mock.module('../../shared/db', () => ({
  db: { execute: async () => [{ live: true }] },
}));
mock.module('../../projects/task-worker-prompt-admission', () => ({
  projectTaskWorkerPromptAdmission: async () => {
    const admission = admissions[Math.min(admissionCalls, admissions.length - 1)];
    admissionCalls += 1;
    return admission;
  },
  taskWorkerPromptIsAllowed: (admission: Admission) =>
    admission.state === 'not_worker' ||
    (admission.state === 'bound' && admission.binding.status === 'doing'),
}));
mock.module('../../projects/lib/prompt-connector-preflight', () => ({
  PromptConnectorPreflightUnresolved: class PromptConnectorPreflightUnresolved extends Error {},
  missingPromptConnectorConnections: async () => ({ ok: true }),
}));
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));
mock.module('../../projects/lib/session-token-grant', () => ({
  remintGrantForAgentSwitch: async () => ({ action: 'skip' }),
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: () => {},
}));
mock.module('../../projects/routes/shared', () => ({
  resumeStoppedSandboxByExternalId: async () => true,
}));
mock.module('../../iam', () => ({
  PROJECT_ACTIONS: { PROJECT_AGENT_READ: 'project.agent.read' },
  authorize: async () => ({ allowed: true, reason: 'project_role' }),
}));
mock.module('../backend', () => ({
  loadSandbox: async () => ({ ...ACTIVE_RECORD }),
  routeSandboxIngress: (_record: unknown, request: { port: number }) => ({
    effectivePort: request.port,
  }),
  resolveSandboxIngress: async () => ({ url: 'http://sandbox.local', headers: {} }),
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {},
  markSandboxUsed: () => {},
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {},
}));

const { forwardToSandbox } = await import('./preview');
const { __resetPromptDedupe } = await import('../prompt-dedupe');
const originalFetch = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async () => {
  upstreamCalls += 1;
  return Response.json({ ok: true });
};

const access = {
  kind: 'principal' as const,
  userId: 'user-1',
  callerSessionId: null,
  sandboxAuthored: false,
};
const routes = ['prompt_async', 'message', 'command', 'summarize'] as const;

async function turn(port: 8000 | 4096, route: string, sequence: number): Promise<Response> {
  const body = new TextEncoder().encode(
    JSON.stringify({ parts: [{ type: 'text', text: `turn-${sequence}` }] }),
  ).buffer as ArrayBuffer;
  return forwardToSandbox(
    ACTIVE_RECORD.sandboxId,
    port,
    access,
    'POST',
    `/session/opencode-session-1/${route}`,
    '',
    new Headers({
      'content-type': 'application/json',
      'idempotency-key': `worker-gate-${port}-${route}-${sequence}`,
    }),
    body,
    'http://localhost:3000',
  );
}

beforeEach(() => {
  admissions = [{ state: 'not_worker' }];
  admissionCalls = 0;
  upstreamCalls = 0;
  __resetPromptDedupe();
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
});

describe('forwardToSandbox task-worker prompt admission', () => {
  for (const port of [8000, 4096] as const) {
    for (const route of routes) {
      test(`rejects marker-only child before upstream POST :${port} ${route}`, async () => {
        admissions = [{ state: 'spawned_unbound' }];

        const response = await turn(port, route, 1);

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: 'TASK_LIVENESS_WORKER_UNBOUND',
        });
        expect(admissionCalls).toBe(1);
        expect(upstreamCalls).toBe(0);
      });

      test(`allows registered doing worker through POST :${port} ${route}`, async () => {
        admissions = [{ state: 'bound', binding: { taskId: 'task-1', status: 'doing' } }];

        const response = await turn(port, route, 2);

        expect(response.status).toBe(200);
        expect(admissionCalls).toBe(2);
        expect(upstreamCalls).toBeGreaterThan(0);
      });
    }
  }

  test('rejects marker-only child on the in-box /proxy/4096 turn path', async () => {
    admissions = [{ state: 'spawned_unbound' }];
    const body = new TextEncoder().encode('{}').buffer as ArrayBuffer;

    const response = await forwardToSandbox(
      ACTIVE_RECORD.sandboxId,
      8000,
      access,
      'POST',
      '/proxy/4096/session/opencode-session-1/command',
      '',
      new Headers({ 'content-type': 'application/json' }),
      body,
      'http://localhost:3000',
    );

    expect(response.status).toBe(409);
    expect(upstreamCalls).toBe(0);
  });

  test('rejects a terminal bound worker before upstream dispatch', async () => {
    admissions = [{ state: 'bound', binding: { taskId: 'task-1', status: 'done' } }];

    const response = await turn(8000, 'prompt_async', 3);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'TASK_WORKER_CONFINED',
      task_id: 'task-1',
    });
    expect(upstreamCalls).toBe(0);
  });

  test('re-check rejects a worker that becomes terminal before upstream dispatch', async () => {
    admissions = [
      { state: 'bound', binding: { taskId: 'task-1', status: 'doing' } },
      { state: 'bound', binding: { taskId: 'task-1', status: 'done' } },
    ];

    const response = await turn(8000, 'prompt_async', 4);

    expect(response.status).toBe(409);
    expect(admissionCalls).toBe(2);
    expect(upstreamCalls).toBe(0);
  });
});
