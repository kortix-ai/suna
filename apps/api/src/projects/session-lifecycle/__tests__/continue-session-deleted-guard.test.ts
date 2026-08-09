// continueSession() must not revive a session the user explicitly deleted.
//
// deleteSession() (../actions.ts) stamps metadata.deletedAt and leaves
// project_sessions.status = 'stopped' — the SAME status a normal hibernate
// uses. Before this guard, a queued follow-up delivery (a Slack reply, a
// scheduled trigger firing late, a retried webhook, …) landing after the
// delete would see status === 'stopped' and revive the session by flipping
// it back to 'running' and driving openSession(). This test asserts the
// metadata.deletedAt check short-circuits to 'no-session' before any of that
// happens, and — as a regression guard for the check itself — that a normal
// (non-deleted) stopped session still takes the revival path.
//
// This file mocks the heavier engine.ts dependencies to a throwing stub —
// never actually exercised by either test below (both return before those
// call sites would be reached), they only need to exist so engine.ts's
// top-level imports resolve. `./deliver` and `./await-stage` are deliberately
// NOT mocked here: both are pure (type-only imports, no db/config), their own
// dedicated test files (deliver.test.ts, await-terminal-stage.test.ts) import
// them for real, and `bun:test`'s `mock.module` is process-global rather than
// file-scoped — stubbing them here would leak into those files if bun ever
// runs test files in the same process/order. See the same caveat documented
// in ../../sandbox-reaper.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

const SESSION_ID = 'sess-deleted-guard-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';

let sessionRow: Record<string, unknown> | null = null;
let workerBindingStatus: string | null = null;
let workerAdmissionState: 'not_worker' | 'spawned_unbound' | 'bound' = 'not_worker';
let openSessionResult: Record<string, unknown> | null = null;
let forwardCalls = 0;
let envSyncCalls = 0;
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];

mock.module('../../../config', () => ({ config: {}, SANDBOX_VERSION: 'test' }));

mock.module('../../generated-state-store', () => ({
  projectTaskWorkerAdmissionState: async () => workerAdmissionState,
  getProjectTaskWorkerBinding: async () => workerBindingStatus
    ? { taskId: 'task-1', status: workerBindingStatus }
    : null,
}));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: (_proj: unknown) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        where: async () => {
          updateCalls.push({ table, updates });
        },
      }),
    }),
  },
}));

mock.module('../../../sandbox-proxy/routes/preview', () => ({
  preview: { routes: [] },
  forwardToSandbox: async () => {
    forwardCalls += 1;
    return new Response(null, { status: 204 });
  },
}));
mock.module('../../lib/sessions', () => ({
  deriveKortixApiBase: () => 'http://localhost:8008',
  createProjectSession: async () => {
    throw new Error('createProjectSession: not expected in this test');
  },
}));
mock.module('../../routes/shared', () => ({
  allocateRuntimeOnOpen: async () => {
    throw new Error('allocateRuntimeOnOpen: not expected in continue-session tests');
  },
  openSession: async () => {
    if (openSessionResult) return openSessionResult;
    throw new Error('openSession: not reached when the deletedAt guard trips');
  },
}));
const actualSandboxBackend = await import('../../../sandbox-proxy/backend');
mock.module('../../../sandbox-proxy/backend', () => ({
  ...actualSandboxBackend,
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));
mock.module('../../../platform/service-key', () => ({
  serviceKeyForExternalId: async () => 'service-key-1',
}));
mock.module('../../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {
    envSyncCalls += 1;
  },
}));
mock.module('../../session-title-generate', () => ({
  generateSessionTitleFromFirstPrompt: async () => {},
}));
mock.module('../actor', () => ({
  resolveProjectAutomationActor: async () => 'automation-user-1',
}));
mock.module('../backpressure', () => ({
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));
const actualStore = await import('../store');
mock.module('../store', () => ({
  ...actualStore,
  claimCreateSessionCommand: async () => {
    throw new Error('not expected in this test');
  },
  claimDueLifecycleCommands: async () => {
    throw new Error('not expected in this test');
  },
  markCommandFailed: async () => {
    throw new Error('not expected in this test');
  },
  markCommandQueued: async () => {
    throw new Error('not expected in this test');
  },
  markCommandSucceeded: async () => {
    throw new Error('not expected in this test');
  },
  resultFromExistingCommand: () => {
    throw new Error('not expected in this test');
  },
}));

const { continueSession, createSession, startSession } = await import('../engine');

beforeEach(() => {
  sessionRow = null;
  workerBindingStatus = null;
  workerAdmissionState = 'not_worker';
  openSessionResult = null;
  forwardCalls = 0;
  envSyncCalls = 0;
  updateCalls = [];
});

describe('continueSession — deleted-mid-flight guard', () => {
  test('a stopped session with metadata.deletedAt is never revived', async () => {
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'stopped',
      metadata: { deletedAt: new Date().toISOString(), deletedBy: 'user-1' },
    };

    const result = await continueSession({ sessionId: SESSION_ID, text: 'follow-up' } as never);

    expect(result).toBe('no-session');
    // No project_sessions revival update was attempted — the guard trips
    // before the function ever reaches the stopped/completed revival branch.
    expect(updateCalls).toEqual([]);
  });

  test('a marker-only child cannot reach postPrompt before task binding commits', async () => {
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'running',
      metadata: { task_liveness_binding_required: true },
    };
    workerAdmissionState = 'spawned_unbound';

    const result = await continueSession({ sessionId: SESSION_ID, text: 'escape' } as never);

    expect(result).toBe('failed');
    expect(forwardCalls).toBe(0);
    expect(updateCalls).toEqual([]);
  });

  test('a registered doing worker can reach postPrompt', async () => {
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'running',
      metadata: { task_liveness_binding_required: true },
    };
    workerAdmissionState = 'bound';
    workerBindingStatus = 'doing';
    openSessionResult = {
      stage: 'ready',
      sandbox: { external_id: 'sandbox-1', provider: 'daytona' },
      opencode_session_id: 'opencode-session-1',
    };

    const result = await continueSession({ sessionId: SESSION_ID, text: 'work' } as never);

    expect(result).toBe('delivered');
    expect(envSyncCalls).toBe(1);
    expect(forwardCalls).toBe(1);
  });

  test('a terminal bounded worker is never revived by a queued continuation', async () => {
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'stopped',
      metadata: {},
    };
    workerAdmissionState = 'bound';
    workerBindingStatus = 'done';

    const result = await continueSession({ sessionId: SESSION_ID, text: 'escape' } as never);

    expect(result).toBe('failed');
    expect(updateCalls).toEqual([]);
  });

  test('regression guard: a normal stopped session (no deletedAt) still takes the revival path', async () => {
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'stopped',
      metadata: {},
    };

    // openSession is mocked to throw, so the revival path surfaces as a
    // rejection once it reaches openOnce() — proving the code got past the
    // deletedAt guard and attempted the flip first.
    await expect(
      continueSession({ sessionId: SESSION_ID, text: 'follow-up' } as never),
    ).rejects.toThrow(/openSession/);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe(projectSessions);
    expect(updateCalls[0].updates.status).toBe('running');
  });
});


describe('createSession — bounded worker child confinement', () => {
  test('a terminal bounded worker cannot create a child session', async () => {
    workerBindingStatus = 'done';

    const result = await createSession({
      source: 'ui',
      project: { projectId: PROJECT_ID, accountId: ACCOUNT_ID },
      userId: 'user-1',
      requestingPrincipalType: 'human',
      body: { initial_prompt: 'spawn an unbounded child' },
      callerSessionId: SESSION_ID,
      queuePolicy: 'never',
    } as never);

    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      error: {
        status: 403,
        body: { code: 'TASK_WORKER_CONFINED' },
      },
    });
  });

  test('an active bounded worker cannot delegate outside its registered contract', async () => {
    workerBindingStatus = 'doing';

    const result = await createSession({
      source: 'ui',
      project: { projectId: PROJECT_ID, accountId: ACCOUNT_ID },
      userId: 'user-1',
      requestingPrincipalType: 'human',
      body: { initial_prompt: 'spawn an unbounded child' },
      callerSessionId: SESSION_ID,
      queuePolicy: 'never',
    } as never);

    expect(result.error?.body.code).toBe('TASK_WORKER_CONFINED');
  });
});


describe('startSession — terminal worker confinement', () => {
  test('the unified start substrate rejects terminal worker revival before openSession', async () => {
    workerBindingStatus = 'blocked';

    const result = await startSession({
      source: 'ui',
      loaded: { row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID }, userId: 'user-1' },
      visible: { row: sessionRow ?? {} },
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    } as never);

    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      error: { status: 409, body: { code: 'TASK_WORKER_CONFINED' } },
    });
  });
});
