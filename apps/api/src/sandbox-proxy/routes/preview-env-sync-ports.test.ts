// THE SECRETS-GATE HOLE, at the route.
//
// Three turn-start preparations used to disagree inside ONE request:
//   - `dropUndeclaredPromptAgent` + the env sync keyed on a port-8000-only
//     predicate that never stripped the in-box `/proxy/<n>/` prefix;
//   - the config-convergence gate keyed on `isTurnStartRequest`, which covers
//     4096/4097 AND strips the prefix.
// Platinum rewrites 4096 → 8000 in `routeSandboxIngress`, Daytona does not. So
// the same prompt got the secret refresh and the connector-grant re-mint on
// Platinum and neither on Daytona, purely because of where it was addressed.
//
// `routeSandboxIngress` below is Daytona's shape — a pass-through, effective
// port == addressed port — because that is the provider the hole was open on.
//
// `mock.module` is process-global; the `--isolate` runner gives this file its
// own module graph. Same stub set as ./forward.test.ts, plus counters on the two
// collaborators `runPrePromptEnvSync` drives.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';
import * as realKortixUserContext from '../../shared/kortix-user-context';
import * as realPreviewOwnership from '../../shared/preview-ownership';

const ACTIVE_RECORD = {
  status: 'active',
  serviceKey: 'svc-key',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  externalId: 'ext-1',
  agentName: 'default',
  provider: 'daytona',
};

let envSyncCalls: Array<{ sessionId: string; requestedAgent: string | null }> = [];
let remintCalls: Array<{ sessionAgent: string; requestedAgent: string | null }> = [];

mock.module('../../config', () => ({ config: {} }));
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
mock.module('../../iam', () => ({
  PROJECT_ACTIONS: { PROJECT_AGENT_READ: 'project.agent.read' },
  authorize: async () => ({ allowed: true, reason: 'role' }),
}));
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async (input: { sessionId: string; requestedAgent: string | null }) => {
    envSyncCalls.push({ sessionId: input.sessionId, requestedAgent: input.requestedAgent ?? null });
  },
}));
mock.module('../../projects/lib/session-token-grant', () => ({
  agentLaunchableInProject: async () => true,
  remintGrantForAgentSwitch: async (input: {
    sessionAgent: string;
    requestedAgent: string | null;
  }) => {
    remintCalls.push({
      sessionAgent: input.sessionAgent,
      requestedAgent: input.requestedAgent ?? null,
    });
    return { action: 'skip' };
  },
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/lib/turn-start-convergence', () => ({
  // No database in this file; the real gate would wait out the driver's connect
  // timeout on every prompt. This suite is about the env-sync gate beside it.
  convergeBeforeTurnStart: async () => ({ decision: 'skipped', outcome: null, ms: 0 }),
  scheduleAssetConvergence: () => {},
  convergeModelCatalogForTurnStart: async () => ({ decision: 'skipped' }),
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
// Daytona ingress is a pass-through: the effective port IS the addressed port.
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

const ORIGINAL_FETCH = globalThis.fetch;

const principal = {
  kind: 'principal' as const,
  userId: 'u1',
  callerSessionId: null,
  boundCredentialSessionId: null,
  sandboxAuthored: false,
};
const jsonHeaders = () => new Headers({ 'content-type': 'application/json' });
const bodyOf = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;
const PROMPT_BODY = bodyOf({ parts: [{ type: 'text', text: 'hi' }] });

let fetchCalls = 0;
function queueFetch(...responses: Response[]) {
  fetchCalls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    fetchCalls += 1;
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than queued');
    return next;
  };
}

beforeEach(() => {
  __resetPromptDedupe();
  envSyncCalls = [];
  remintCalls = [];
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

async function prompt(port: number, path: string, body: ArrayBuffer = PROMPT_BODY) {
  queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
  return forwardToSandbox(
    'sb-1',
    port,
    principal,
    'POST',
    path,
    '',
    jsonHeaders(),
    body,
    'http://app.local',
  );
}

describe('the pre-prompt env sync runs on every port a turn can start on', () => {
  test('a prompt addressed straight at :4096 gets the secret refresh and the grant re-mint', async () => {
    const res = await prompt(4096, '/session/sess-1/prompt_async');
    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(1);
    expect(envSyncCalls).toEqual([{ sessionId: 'sess-1', requestedAgent: null }]);
    expect(remintCalls).toEqual([{ sessionAgent: 'default', requestedAgent: null }]);
  });

  test('the standby half :4097 is covered too — a verified reload swaps which is live', async () => {
    const res = await prompt(4097, '/session/sess-1/message');
    expect(res.status).toBe(200);
    expect(envSyncCalls).toHaveLength(1);
    expect(remintCalls).toHaveLength(1);
  });

  test('the in-box /proxy/<n>/ prefix is stripped, so a nested prompt is still a prompt', async () => {
    const res = await prompt(8000, '/proxy/4096/session/sess-1/message');
    expect(res.status).toBe(200);
    expect(envSyncCalls).toHaveLength(1);
    expect(remintCalls).toHaveLength(1);
  });

  test('the daemon port keeps working exactly as before', async () => {
    const res = await prompt(8000, '/session/sess-1/message');
    expect(res.status).toBe(200);
    expect(envSyncCalls).toHaveLength(1);
    expect(remintCalls).toHaveLength(1);
  });

  test('the requested agent is re-scoped on :4096, not silently run under the old grant', async () => {
    const res = await prompt(
      4096,
      '/session/sess-1/prompt_async',
      bodyOf({ agent: 'writer', parts: [{ type: 'text', text: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    expect(envSyncCalls).toEqual([{ sessionId: 'sess-1', requestedAgent: 'writer' }]);
    expect(remintCalls).toEqual([{ sessionAgent: 'default', requestedAgent: 'writer' }]);
  });

  // The deliberate boundary. Compaction carries no user prompt and no `agent`,
  // and the sync is fail-closed on a grant error — refusing to compact because a
  // manifest read failed would wedge a session instead of protecting it.
  test('/summarize still gets NO env sync, on either port', async () => {
    await prompt(4096, '/session/sess-1/summarize');
    await prompt(8000, '/session/sess-1/summarize');
    expect(envSyncCalls).toHaveLength(0);
    expect(remintCalls).toHaveLength(0);
  });

  test('a non-session port is not a turn start', async () => {
    await prompt(3000, '/session/sess-1/prompt_async');
    expect(envSyncCalls).toHaveLength(0);
    expect(remintCalls).toHaveLength(0);
  });
});
