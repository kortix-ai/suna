// The ACP relay must inspect `session/set_config_option` before forwarding it.
//
// On an OpenCode session the ACP `mode` config option IS the harness agent
// selector, and the harness agent IS the Kortix agent identity the session
// token's `agent_grant` was minted for. Relaying a foreign `mode` value
// therefore runs agent B under agent A's connector / Kortix-CLI grant — the
// exact escalation projects/lib/session-token-grant.ts documents.
//
// On claude / codex / pi the same `mode` option carries the harness's own
// permission or approval preset, never an agent identity, so the value must NOT
// be policed there.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let sessionMetadata: Record<string, unknown> = {};
let appended: unknown[] = [];
let upstreamFetchCount = 0;
let envSyncCount = 0;

mock.module('../lib/access', () => ({
  assertProjectCapability: async () => {},
  loadProjectForUser: async () => ({
    userId: 'user-1',
    row: { projectId: PROJECT_ID, accountId: 'account-1' },
  }),
  loadVisibleSession: async () => ({
    row: { sessionId: SESSION_ID, metadata: sessionMetadata },
    canManageSharing: true,
  }),
}));

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === sessionSandboxes ? [{ externalId: 'sandbox-external-1' }] : [],
        }),
      }),
    }),
  },
}));

mock.module('../runtime-inspection', () => ({
  sandboxRuntimeEndpoint: async () => ({
    url: 'https://sandbox.test',
    headers: { 'x-kortix-user-context': 'signed' },
    providerHeaders: {},
    serviceKey: 'service-key',
  }),
}));

mock.module('../../sandbox-proxy/backend', () => ({
  invalidateSandbox: () => {},
}));

mock.module('../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {
    envSyncCount += 1;
  },
}));

mock.module('../lib/acp-transcript', () => ({
  appendAcpEnvelope: async (input: unknown) => {
    appended.push(input);
    return { ordinal: appended.length, envelope: (input as { envelope: unknown }).envelope };
  },
  loadAcpTranscript: async () => [],
}));

mock.module('../lib/acp-sse-proxy', () => ({
  createPersistedAcpSseProxy: (body: ReadableStream<Uint8Array>) => body,
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (_input, init) => {
  upstreamFetchCount += 1;
  const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return Response.json({ jsonrpc: '2.0', id: request.id, result: {} });
}) as typeof fetch;

const { projectsApp } = await import('../lib/app');
await import('./acp');

function acpSession(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    runtime_transport: 'acp',
    acp_server_id: SESSION_ID,
    runtime_harness: 'opencode',
    ...overrides,
  };
}

function setMode(value: unknown, configId = 'mode') {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-mode',
      method: 'session/set_config_option',
      params: { sessionId: 'native-session', configId, value },
    }),
  });
}

beforeEach(() => {
  appended = [];
  upstreamFetchCount = 0;
  envSyncCount = 0;
  sessionMetadata = acpSession({ native_agent: 'pipeline-hygiene' });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

test('OpenCode: a mode naming a DIFFERENT agent is refused 409 before it is relayed', async () => {
  const response = await setMode('nda-turnaround');

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'agent switch requires a new session',
    code: 'AGENT_SWITCH_REQUIRES_NEW_SESSION',
    expected_agent: 'pipeline-hygiene',
    requested_agent: 'nda-turnaround',
  });
  // Never forwarded, and never written into the transcript as if it had been.
  expect(upstreamFetchCount).toBe(0);
  expect(appended).toEqual([]);
});

test('OpenCode: setting the mode to the session own agent is a no-op and allowed', async () => {
  const response = await setMode('pipeline-hygiene');

  expect(response.status).toBe(200);
  expect(upstreamFetchCount).toBe(1);
});

test('OpenCode: a non-string mode value cannot prove it is the same agent, so it is refused', async () => {
  const response = await setMode({ id: 'nda-turnaround' });

  expect(response.status).toBe(409);
  expect(upstreamFetchCount).toBe(0);
});

test('OpenCode: with no committed native agent, a built-in mode (plan) still passes', async () => {
  sessionMetadata = acpSession({ native_agent: null });

  const response = await setMode('plan');

  expect(response.status).toBe(200);
  expect(upstreamFetchCount).toBe(1);
});

test('Claude: a permission-mode change is NOT an agent switch and must pass', async () => {
  sessionMetadata = acpSession({ runtime_harness: 'claude', native_agent: 'reviewer' });

  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
    upstreamFetchCount = 0;
    const response = await setMode(mode);
    expect(response.status).toBe(200);
    expect(upstreamFetchCount).toBe(1);
  }
});

test('Codex: an approval-preset change is NOT an agent switch and must pass', async () => {
  sessionMetadata = acpSession({ runtime_harness: 'codex', native_agent: 'reviewer' });

  const response = await setMode('agent-full-access');

  expect(response.status).toBe(200);
  expect(upstreamFetchCount).toBe(1);
});

test('only configId "mode" is policed — a model change on the same session passes', async () => {
  const response = await setMode('kortix/glm-5.2', 'model');

  expect(response.status).toBe(200);
  expect(upstreamFetchCount).toBe(1);
});

test('the refusal costs no env sync and no turn observation', async () => {
  await setMode('nda-turnaround');

  expect(envSyncCount).toBe(0);
});
