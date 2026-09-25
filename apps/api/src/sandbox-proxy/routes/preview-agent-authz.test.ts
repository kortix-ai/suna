// A prompt that names a CONCRETE different agent must be AUTHORIZED for that
// agent before anything acts on it.
//
// `project.agent.read` was asserted only at session create (projects/routes/project-sessions.ts),
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
import * as realPreviewOwnership from '../../shared/preview-ownership';
import * as realKortixUserContext from '../../shared/kortix-user-context';

let sessionAgentName: string | null = 'pipeline-hygiene';

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
const undeclaredAgents = new Set<string>();
let envSyncCalls: Array<{ requestedAgent: string | null | undefined }> = [];

mock.module('../../config', () => ({ config: {} }));
mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure lands
// in whatever unrelated file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.
// Overriding only what this file needs keeps new exports working by default.
mock.module('../../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
}));
mock.module('../../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
mock.module('../../iam', () => ({
  PROJECT_ACTIONS: { PROJECT_AGENT_READ: 'project.agent.read' },
  // `authorize(actor, action, obj)` — the acting credential is part of the
  // Actor now, so the action moved to position 2.
  authorize: async (_actor: unknown, action: string, target: unknown) => {
    authorizeCalls.push({ action, target });
    return authorizeAllowed
      ? { allowed: true, reason: 'role' }
      : { allowed: false, reason: 'resource_scope_insufficient' };
  },
}));
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async (input: { requestedAgent?: string | null }) => {
    envSyncCalls.push({ requestedAgent: input.requestedAgent });
  },
}));
mock.module('../../projects/lib/session-token-grant', () => ({
  // Declared-agent guard: every name these cases use is declared unless a test
  // puts it in `undeclaredAgents`.
  agentLaunchableInProject: async (_projectId: string, agentName: string) =>
    !undeclaredAgents.has(agentName),
  remintGrantForAgentSwitch: async (input: { requestedAgent: string | null }) => {
    remintCalls.push({ requestedAgent: input.requestedAgent });
    return { action: 'skip' };
  },
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: () => {},
}));
const realTurnLifecycle = await import('../../projects/sandbox-turn-lifecycle');
mock.module('../../projects/sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  beginSandboxTurn: async () => 'granted',
  acceptSandboxTurn: async () => true,
  abandonSandboxTurn: async () => true,
}));
mock.module('../../projects/routes/shared', () => ({
  resumeStoppedSandboxByExternalId: async () => true,
}));
mock.module('../backend', () => ({
  loadSandbox: async () => ({ ...ACTIVE_RECORD, agentName: sessionAgentName }),
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
let upstreamBodies: Array<Record<string, unknown>> = [];
(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: unknown }) => {
  upstreamCalls += 1;
  if (init?.body) {
    try {
      const raw =
        typeof init.body === 'string'
          ? init.body
          : new TextDecoder().decode(init.body as ArrayBuffer);
      upstreamBodies.push(JSON.parse(raw));
    } catch {
      // non-JSON upstream bodies are not asserted here
    }
  }
  return Response.json({ ok: true });
};

const ACCESS = {
  kind: 'principal' as const,
  userId: 'user-1',
  callerSessionId: null,
  boundCredentialSessionId: null,
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
  sessionAgentName = 'pipeline-hygiene';
  authorizeCalls = [];
  authorizeAllowed = true;
  remintCalls = [];
  envSyncCalls = [];
  upstreamCalls = 0;
  upstreamBodies = [];
  undeclaredAgents.clear();
  __resetPromptDedupe();
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  mock.restore();
});

// The authorization decision itself (scoped out → 403 before the re-mint,
// scoped in → re-mint and forward, the gate checks the REQUESTED agent, the
// own-agent exemption) runs on the real IAM engine in
// __tests__/integration-preview-agent-authz.test.ts.
test('an ordinary turn with no agent field pays for no authorization round-trip', async () => {
  const response = await prompt();

  expect(response.status).toBe(200);
  expect(authorizeCalls).toEqual([]);
  expect(upstreamCalls).toBe(1);
});

// The sentinel echo stays free, whatever the session is bound to: asking for
// 'default' is asking for this session's own agent, so there is no concrete
// agent to authorize and no round-trip to pay for.
test.each(['pipeline-hygiene', 'default'])(
  'the non-binding "default" sentinel is not a switch and is not gated (session agent %s)',
  async (sessionAgent) => {
    sessionAgentName = sessionAgent;

    const response = await prompt('default');

    expect(response.status).toBe(200);
    expect(authorizeCalls).toEqual([]);
  },
);

// REGRESSION (CWE-863). A `default`-bound session used to skip this gate
// entirely: `isConcreteAgentSwitch` carved out `sessionAgent === 'default'`, so
// naming a concrete agent reached neither the authorization check nor a refusal.
// That was not harmless. The body's `agent` is stripped only when the REQUESTED
// agent is the sentinel, so the named agent really ran, and the token really was
// re-minted to its connector/Kortix-CLI grant. Anyone who could use a
// default-bound session could run any agent in the project.
test('a default-bound session naming a concrete agent IS authorized', async () => {
  sessionAgentName = 'default';
  authorizeAllowed = false;

  const response = await prompt('nda-turnaround');

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  // The bypass handed over the grant. Neither may run.
  expect(remintCalls).toEqual([]);
  expect(envSyncCalls).toEqual([]);
  expect(upstreamCalls).toBe(0);
});

test('a default-bound session still runs a concrete agent once authorized', async () => {
  sessionAgentName = 'default';

  const response = await prompt('nda-turnaround');

  expect(response.status).toBe(200);
  expect(authorizeCalls).toHaveLength(1);
  expect(remintCalls).toEqual([{ requestedAgent: 'nda-turnaround' }]);
  expect(upstreamCalls).toBe(1);
});

// ── INC-2026-09-15: an agent this project does not declare never reaches a gate ──

test('a prompt naming an agent the project does not declare is delivered as the session agent', async () => {
  undeclaredAgents.add('foreign-agent');

  const response = await prompt('foreign-agent');

  expect(response.status).toBe(200);
  // Not an authorization question: the name is not this project's at all.
  expect(authorizeCalls).toEqual([]);
  // Neither the env sync nor the token re-mint ever sees the foreign name.
  expect(envSyncCalls.map((c) => c.requestedAgent ?? null)).toEqual([null]);
  expect(remintCalls).toEqual([{ requestedAgent: null }]);
  // The runtime receives the prompt with no agent field: OpenCode's default_agent runs.
  expect(upstreamCalls).toBe(1);
  expect(upstreamBodies.at(-1)).not.toHaveProperty('agent');
  expect(upstreamBodies.at(-1)?.parts).toEqual([
    { type: 'text', text: expect.stringMatching(/^hi /) },
  ]);
});

test('a declared agent switch is untouched by the guard', async () => {
  undeclaredAgents.add('foreign-agent');

  const response = await prompt('nda-turnaround');

  expect(response.status).toBe(200);
  expect(remintCalls).toEqual([{ requestedAgent: 'nda-turnaround' }]);
  expect(upstreamBodies.at(-1)).toMatchObject({ agent: 'nda-turnaround' });
});
