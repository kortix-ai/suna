// `/v1/p/<external_id>/8000/kortix/acp/<server_id>` reaches the SAME daemon ACP
// endpoint as the managed route in projects/routes/acp.ts. Verified live on
// 2026-07-30: a `session/set_config_option` posted through this proxy path was
// relayed to the harness and changed its mode, with the managed route's guard
// never consulted. A control on one edge and not the other is not a control.
//
// The rule itself lives in projects/lib/acp-agent-mode.ts and is unit-tested
// through both edges; this file pins that the PROXY edge applies it, refuses
// before forwarding, and pays for the session lookup only on a real mode change.
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

let sessionMetadata: Record<string, unknown> = {};
let metadataLookups = 0;
let upstreamCalls = 0;

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
mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            metadataLookups += 1;
            return [{ metadata: sessionMetadata }];
          },
        }),
      }),
    }),
  },
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
(globalThis as { fetch: unknown }).fetch = async () => {
  upstreamCalls += 1;
  return Response.json({ ok: true });
};

let rpcSeq = 0;

function postEnvelope(envelope: Record<string, unknown>): Promise<Response> {
  rpcSeq += 1;
  return forwardToSandbox(
    'sbx-1',
    8000,
    { kind: 'principal', userId: 'user-1', callerSessionId: null, sandboxAuthored: false },
    'POST',
    '/kortix/acp/sess-1',
    '?agent=opencode',
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: `rpc-${rpcSeq}`, ...envelope }))
      .buffer as ArrayBuffer,
    'http://localhost:3000',
  );
}

function setMode(value: unknown, configId = 'mode'): Promise<Response> {
  return postEnvelope({
    method: 'session/set_config_option',
    params: { sessionId: 'native-session', configId, value },
  });
}

beforeEach(() => {
  metadataLookups = 0;
  upstreamCalls = 0;
  sessionMetadata = { runtime_harness: 'opencode', native_agent: 'pipeline-hygiene' };
  __resetPromptDedupe();
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  mock.restore();
});

test('the proxy edge refuses a foreign agent mode with the same 409 as the managed route', async () => {
  const response = await setMode('nda-turnaround');

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: 'AGENT_SWITCH_REQUIRES_NEW_SESSION',
    expected_agent: 'pipeline-hygiene',
    requested_agent: 'nda-turnaround',
  });
  expect(upstreamCalls).toBe(0);
});

test('the session own agent passes through', async () => {
  const response = await setMode('pipeline-hygiene');

  expect(response.status).toBe(200);
  expect(upstreamCalls).toBe(1);
});

test('a Claude permission-mode change is not policed on the proxy edge either', async () => {
  sessionMetadata = { runtime_harness: 'claude', native_agent: 'reviewer' };

  const response = await setMode('acceptEdits');

  expect(response.status).toBe(200);
  expect(upstreamCalls).toBe(1);
});

test('with no committed native agent an OpenCode built-in mode passes', async () => {
  sessionMetadata = { runtime_harness: 'opencode', native_agent: null };

  const response = await setMode('plan');

  expect(response.status).toBe(200);
  expect(upstreamCalls).toBe(1);
});

test('a non-mode envelope costs no session lookup at all', async () => {
  const model = await setMode('kortix/glm-5.2', 'model');
  expect(model.status).toBe(200);

  const prompt = await postEnvelope({
    method: 'session/prompt',
    params: { sessionId: 'native-session', prompt: [{ type: 'text', text: 'hi' }] },
  });
  expect(prompt.status).toBe(200);

  expect(metadataLookups).toBe(0);
});
