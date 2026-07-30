import { beforeEach, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let persistCalls: unknown[] = [];
let persistError: Error | null = null;
let capabilityActions: string[] = [];

class TestConflictError extends Error {
  constructor(
    readonly code: string,
    readonly storedAcpSessionId: string | null = null,
  ) {
    super(code);
  }
}

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
  loadProjectForUser: async (_c: unknown, projectId: string) =>
    projectId === PROJECT_ID
      ? { userId: 'user-1', row: { projectId: PROJECT_ID, accountId: 'account-1' } }
      : null,
  loadVisibleSession: async (_loaded: unknown, sessionId: string) =>
    sessionId === SESSION_ID ? { row: { sessionId: SESSION_ID } } : null,
}));

mock.module('../lib/acp-session-identity', () => ({
  AcpSessionIdentityConflictError: TestConflictError,
  persistAcpSessionIdentity: async (_deps: unknown, input: unknown) => {
    persistCalls.push(input);
    if (persistError) throw persistError;
    return {
      acp_server_id: SESSION_ID,
      runtime_harness: 'codex',
      acp_session_id: 'codex-native-1',
    };
  },
}));

mock.module('../../shared/db', () => ({ db: {}, hasDatabase: true }));

const { projectsApp } = await import('../lib/app');
await import('./acp-identity');

beforeEach(() => {
  persistCalls = [];
  persistError = null;
  capabilityActions = [];
});

function putIdentity(body: Record<string, unknown>) {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp-identity`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('PUT .../acp-identity persists the immutable server, harness, and protocol ids', async () => {
  const response = await putIdentity({
    acp_server_id: SESSION_ID,
    runtime_harness: 'codex',
    acp_session_id: 'codex-native-1',
  });

  expect(response.status).toBe(200);
  expect(capabilityActions).toEqual(['project.session.start']);
  expect(persistCalls).toEqual([
    {
      projectId: PROJECT_ID,
      projectSessionId: SESSION_ID,
      acpServerId: SESSION_ID,
      runtimeHarness: 'codex',
      acpSessionId: 'codex-native-1',
    },
  ]);
  expect(await response.json()).toEqual({
    acp_server_id: SESSION_ID,
    runtime_harness: 'codex',
    acp_session_id: 'codex-native-1',
  });
});

test('PUT .../acp-identity maps immutable binding conflicts to HTTP 409', async () => {
  persistError = new TestConflictError('ACP_SESSION_ID_CONFLICT');

  const response = await putIdentity({
    acp_server_id: SESSION_ID,
    runtime_harness: 'codex',
    acp_session_id: 'codex-native-2',
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'ACP_SESSION_ID_CONFLICT',
    code: 'ACP_SESSION_ID_CONFLICT',
  });
});

test('PUT .../acp-identity returns the winning acp_session_id with the 409', async () => {
  persistError = new TestConflictError('ACP_SESSION_ID_CONFLICT', 'codex-native-winner');

  const response = await putIdentity({
    acp_server_id: SESSION_ID,
    runtime_harness: 'codex',
    acp_session_id: 'codex-native-loser',
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'ACP_SESSION_ID_CONFLICT',
    code: 'ACP_SESSION_ID_CONFLICT',
    acp_session_id: 'codex-native-winner',
  });
});

test('PUT .../acp-identity rejects an unsupported harness before persistence', async () => {
  const response = await putIdentity({
    acp_server_id: SESSION_ID,
    runtime_harness: 'other',
    acp_session_id: 'native-1',
  });

  expect(response.status).toBe(400);
  expect(persistCalls).toHaveLength(0);
});
