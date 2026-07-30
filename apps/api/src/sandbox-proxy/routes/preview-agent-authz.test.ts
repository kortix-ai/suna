// A prompt that names a CONCRETE different agent must be AUTHORIZED for that
// agent before anything acts on it.
//
// `project.agent.read` was asserted only at session create (projects/routes/r7.ts),
// against `body.agent_name`. The prompt path never re-checked, so a member scoped
// to agent A could create the session as A and then prompt `{"agent":"B"}` — and
// `remintGrantForAgentSwitch` would hand them B's connector / Kortix-CLI grant,
// because the re-mint is a re-scoping mechanism, not an authorization one
// (`remintDecisionFor` refuses only the fully-null UNRESTRICTED widening).
//
// The check must run BEFORE the env sync and BEFORE the re-mint: both are
// side-effecting, and the re-mint is the thing that grants B.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';

const ACTIVE_RECORD = {
  status: 'active',
  serviceKey: 'svc-key',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  externalId: 'ext-1',
  sandboxId: 'sbx-1',
  agentName: 'pipeline-hygiene',
  provider: 'daytona',
};

let authorizeCalls: Array<{ action: string; target: unknown }> = [];
let authorizeAllowed = true;
let remintCalls: Array<{ requestedAgent: string | null }> = [];
let envSyncCalls: Array<{ requestedAgent: string | null | undefined }> = [];

mock.module('../../config', () => ({ config: { KORTIX_ENFORCE_SESSION_AGENT_LOCK: false } }));
mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
mock.module('../../shared/kortix-user-context', () => ({
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
}));
mock.module('../../shared/preview-ownership', () => ({
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
mock.module('../../iam', () => ({
  PROJECT_ACTIONS: { PROJECT_AGENT_READ: 'project.agent.read' },
  authorize: async (_userId: string, _accountId: string, action: string, target: unknown) => {
    authorizeCalls.push({ action, target });
    return authorizeAllowed
      ? { allowed: true, reason: 'project_role' }
      : { allowed: false, reason: 'resource_scope_insufficient' };
  },
}));
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async (input: { requestedAgent?: string | null }) => {
    envSyncCalls.push({ requestedAgent: input.requestedAgent });
  },
}));
mock.module('../../projects/lib/session-token-grant', () => ({
  remintGrantForAgentSwitch: async (input: { requestedAgent: string | null }) => {
    remintCalls.push({ requestedAgent: input.requestedAgent });
    return { action: 'skip' };
  },
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: () => {},
}));
mock.module('../../projects/routes/shared', () => ({
  resumeStoppedSandboxByExternalId: async () => true,
}));
mock.module('../backend', () => ({
  loadSandbox: async () => ({ ...ACTIVE_RECORD }),
  routeSandboxIngress: () => ({ effectivePort: 8000 }),
  resolveSandboxIngress: async () => ({ url: 'http://sandbox.local', headers: {} }),
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {},
  markSandboxUsed: () => {},
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {},
}));

const { forwardToSandbox } = await import('./preview');
const { __resetPromptDedupe } = await import('../prompt-dedupe');

const ORIGINAL_FETCH = globalThis.fetch;
let upstreamCalls = 0;
(globalThis as { fetch: unknown }).fetch = async () => {
  upstreamCalls += 1;
  return Response.json({ ok: true });
};

const ACCESS = {
  kind: 'principal' as const,
  userId: 'user-1',
  callerSessionId: null,
  sandboxAuthored: false,
};

let promptSeq = 0;

function prompt(agent?: string | null): Promise<Response> {
  promptSeq += 1;
  const payload: Record<string, unknown> = { parts: [{ type: 'text', text: `hi ${promptSeq}` }] };
  if (agent !== undefined) payload.agent = agent;
  return forwardToSandbox(
    'sbx-1',
    8000,
    ACCESS,
    'POST',
    '/session/ses_1/prompt_async',
    '',
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
    'http://localhost:3000',
  );
}

beforeEach(() => {
  authorizeCalls = [];
  authorizeAllowed = true;
  remintCalls = [];
  envSyncCalls = [];
  upstreamCalls = 0;
  __resetPromptDedupe();
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  mock.restore();
});

test('a prompt naming an agent the caller is not scoped to is refused 403 BEFORE any re-mint', async () => {
  authorizeAllowed = false;

  const response = await prompt('nda-turnaround');

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  // The whole point: the re-mint is what hands over B's grant, so it must not run.
  expect(remintCalls).toEqual([]);
  expect(envSyncCalls).toEqual([]);
  expect(upstreamCalls).toBe(0);
});

test('the gate asks for project.agent.read on the REQUESTED agent as a resource', async () => {
  await prompt('nda-turnaround');

  expect(authorizeCalls).toEqual([
    {
      action: 'project.agent.read',
      target: {
        type: 'project',
        id: 'proj-1',
        resource: { type: 'agent', id: 'nda-turnaround' },
      },
    },
  ]);
});

test('an authorized switch still re-mints and forwards', async () => {
  const response = await prompt('nda-turnaround');

  expect(response.status).toBe(200);
  expect(remintCalls).toEqual([{ requestedAgent: 'nda-turnaround' }]);
  expect(upstreamCalls).toBe(1);
});

test('an ordinary turn with no agent field pays for no authorization round-trip', async () => {
  const response = await prompt();

  expect(response.status).toBe(200);
  expect(authorizeCalls).toEqual([]);
  expect(upstreamCalls).toBe(1);
});

test('the non-binding "default" sentinel is not a switch and is not gated', async () => {
  const response = await prompt('default');

  expect(response.status).toBe(200);
  expect(authorizeCalls).toEqual([]);
});

test('naming the session own agent is not a switch and is not gated', async () => {
  const response = await prompt('pipeline-hygiene');

  expect(response.status).toBe(200);
  expect(authorizeCalls).toEqual([]);
});
