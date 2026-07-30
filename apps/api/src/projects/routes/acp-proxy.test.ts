import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let appended: unknown[] = [];
let upstreamUrl = '';
let upstreamHeaders = new Headers();
let syncedProviderHeaders: Record<string, string> | null = null;
let accessActions: string[] = [];
let capabilityActions: string[] = [];
let canManageSharing = true;
let endpointCalls = 0;
let invalidatedSandboxIds: string[] = [];
let upstreamStatuses: number[] = [];
let upstreamFetchCount = 0;
let envSyncStatuses: number[] = [];

mock.module('../lib/access', () => ({
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    _accountId: string,
    _projectId: string,
    action: string,
  ) => {
    capabilityActions.push(action);
  },
  loadProjectForUser: async (_c: unknown, _projectId: string, action: string) => {
    accessActions.push(action);
    return {
      userId: 'user-1',
      row: { projectId: PROJECT_ID, accountId: 'account-1' },
    };
  },
  loadVisibleSession: async () => ({
    row: {
      sessionId: SESSION_ID,
      metadata: {
        runtime_transport: 'acp',
        runtime_harness: 'codex',
        acp_server_id: SESSION_ID,
      },
    },
    canManageSharing,
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
  sandboxRuntimeEndpoint: async () => {
    endpointCalls += 1;
    return {
      url: 'https://sandbox.test',
      headers: { 'x-kortix-user-context': 'signed' },
      providerHeaders: { 'x-daytona-preview-token': 'preview' },
      serviceKey: 'service-key',
    };
  },
}));

mock.module('../../sandbox-proxy/backend', () => ({
  invalidateSandbox: (externalId: string) => {
    invalidatedSandboxIds.push(externalId);
  },
}));

mock.module('../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async (input: {
    providerHeaders: Record<string, string>;
  }) => {
    const status = envSyncStatuses.shift();
    if (status) throw new Error(`env sync failed: ${status}`);
    syncedProviderHeaders = input.providerHeaders;
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

// Keep the REAL envelope parsing — that is the part this route decides — and
// capture only the generator call.
let titleCalls: Array<Record<string, unknown>> = [];
const realTitleGenerate = await import('../session-title-generate');
mock.module('../session-title-generate', () => ({
  ...realTitleGenerate,
  generateSessionTitleFromFirstPrompt: async (input: Record<string, unknown>) => {
    titleCalls.push(input);
  },
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  upstreamFetchCount += 1;
  upstreamUrl = String(input);
  upstreamHeaders = new Headers(init?.headers);
  const status = upstreamStatuses.shift();
  if (status && status !== 200) {
    return Response.json({ error: 'stale ingress credential' }, { status });
  }
  if (init?.method === 'DELETE') {
    return new Response(null, { status: 204 });
  }
  if (init?.method === 'GET') {
    return new Response('id: 1\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return Response.json({
    jsonrpc: '2.0',
    id: request.id,
    result: { protocolVersion: 1 },
  });
}) as typeof fetch;

const { projectsApp } = await import('../lib/app');
await import('./acp');

beforeEach(() => {
  appended = [];
  upstreamUrl = '';
  upstreamHeaders = new Headers();
  syncedProviderHeaders = null;
  accessActions = [];
  capabilityActions = [];
  canManageSharing = true;
  endpointCalls = 0;
  invalidatedSandboxIds = [];
  upstreamStatuses = [];
  upstreamFetchCount = 0;
  envSyncStatuses = [];
  titleCalls = [];
});

afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

test('POST .../acp proxies through the immutable harness route and persists both envelopes', async () => {
  const request = {
    jsonrpc: '2.0',
    id: 'rpc-1',
    method: 'initialize',
    params: { protocolVersion: 1 },
  };
  const response = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  expect(response.status).toBe(200);
  expect(accessActions).toEqual(['session']);
  expect(capabilityActions).toEqual(['project.session.start']);
  expect(upstreamUrl).toBe(`https://sandbox.test/kortix/acp/${SESSION_ID}?agent=codex`);
  expect(upstreamHeaders.get('x-kortix-user-context')).toBe('signed');
  expect(appended).toEqual([
    expect.objectContaining({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      direction: 'client_to_agent',
      envelope: request,
    }),
    expect.objectContaining({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      direction: 'agent_to_client',
      envelope: expect.objectContaining({
        id: 'rpc-1',
        result: { protocolVersion: 1 },
      }),
    }),
  ]);
});

test('session/prompt syncs env with provider headers and no user context', async () => {
  const response = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-prompt',
      method: 'session/prompt',
      params: { sessionId: 'native-session', prompt: [] },
    }),
  });

  expect(response.status).toBe(200);
  expect(syncedProviderHeaders).toEqual({
    'x-daytona-preview-token': 'preview',
  });
});

test('session/prompt titles the session — but only once the box ACCEPTED the prompt', async () => {
  const send = (id: string) =>
    projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'session/prompt',
        params: {
          sessionId: 'native-session',
          prompt: [{ type: 'text', text: 'set up the MS Graph connector' }],
          model: { providerID: 'kortix', modelID: 'glm-5.2' },
        },
      }),
    });

  const accepted = await send('rpc-title');
  expect(accepted.status).toBe(200);
  expect(titleCalls).toMatchObject([
    {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      firstPromptText: 'set up the MS Graph connector',
      modelHint: 'glm-5.2',
    },
  ]);

  // A prompt the agent never saw must not name the session — the user retypes
  // it, and `needsTitle` would already be false by then.
  titleCalls = [];
  upstreamStatuses = [502, 502];
  const rejected = await send('rpc-title-failed');
  expect(rejected.status).toBe(502);
  expect(titleCalls).toEqual([]);
});

test('session/prompt refreshes stale ingress credentials when env sync rejects authentication', async () => {
  envSyncStatuses = [401];

  const response = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-prompt-retry',
      method: 'session/prompt',
      params: { sessionId: 'native-session', prompt: [] },
    }),
  });

  expect(response.status).toBe(200);
  expect(endpointCalls).toBe(2);
  expect(invalidatedSandboxIds).toEqual(['sandbox-external-1']);
  expect(syncedProviderHeaders).toEqual({
    'x-daytona-preview-token': 'preview',
  });
});

test('POST .../acp refreshes stale ingress credentials once after an auth rejection', async () => {
  upstreamStatuses = [401, 200];
  const request = {
    jsonrpc: '2.0',
    id: 'rpc-retry',
    method: 'initialize',
    params: { protocolVersion: 1 },
  };

  const response = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  expect(response.status).toBe(200);
  expect(endpointCalls).toBe(2);
  expect(upstreamFetchCount).toBe(2);
  expect(invalidatedSandboxIds).toEqual(['sandbox-external-1']);
  expect(appended.map((entry) => (entry as { direction: string }).direction)).toEqual([
    'client_to_agent',
    'agent_to_client',
  ]);
});

test('GET .../acp refreshes stale ingress credentials once after an auth rejection', async () => {
  upstreamStatuses = [401, 200];

  const response = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`);

  expect(response.status).toBe(200);
  expect(endpointCalls).toBe(2);
  expect(upstreamFetchCount).toBe(2);
  expect(invalidatedSandboxIds).toEqual(['sandbox-external-1']);
});

test('GET transcript retains project read access', async () => {
  const response = await projectsApp.request(
    `/${PROJECT_ID}/sessions/${SESSION_ID}/acp/transcript`,
  );

  expect(response.status).toBe(200);
  expect(accessActions).toEqual(['read']);
  expect(capabilityActions).toEqual(['project.session.read']);
});

test('DELETE .../acp requires stop capability and session-management authority', async () => {
  const response = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'DELETE',
  });

  expect(response.status).toBe(204);
  expect(accessActions).toEqual(['session']);
  expect(capabilityActions).toEqual(['project.session.stop']);
});

test('DELETE .../acp rejects a visible session that the caller cannot manage', async () => {
  canManageSharing = false;

  const response = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'DELETE',
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: 'Only the session owner or an account owner/admin can stop this session',
  });
});
