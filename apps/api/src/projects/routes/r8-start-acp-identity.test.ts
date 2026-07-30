import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { projectSessions } from '@kortix/db';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const STALE_METADATA = {
  runtime_transport: 'acp',
  runtime_harness: 'codex',
  acp_server_id: SESSION_ID,
};

let storedMetadata: Record<string, unknown> = { ...STALE_METADATA };
let metadataReads: Array<Record<string, unknown>> = [];
let writeDuringPoll: string | null = null;
let startCalls = 0;

mock.module('../lib/access', () => ({
  assertProjectCapability: async () => {},
  loadProjectForUser: async (_c: unknown, projectId: string) =>
    projectId === PROJECT_ID
      ? { userId: 'user-1', row: { projectId: PROJECT_ID, accountId: 'account-1', metadata: {} } }
      : null,
  loadVisibleSession: async (_loaded: unknown, sessionId: string) =>
    sessionId === SESSION_ID
      ? { row: { sessionId: SESSION_ID, metadata: { ...STALE_METADATA } }, canManageSharing: true }
      : null,
}));

mock.module('../../billing/services/billing-gate', () => ({
  checkBillingActive: async () => ({ ok: true }),
}));

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table !== projectSessions) return [];
            const snapshot = { ...storedMetadata };
            metadataReads.push(snapshot);
            return [{ metadata: snapshot }];
          },
        }),
      }),
    }),
  },
}));

mock.module('../session-lifecycle', () => ({
  startSession: async () => {
    startCalls += 1;
    if (writeDuringPoll) {
      storedMetadata = { ...storedMetadata, acp_session_id: writeDuringPoll };
    }
    return {
      status: 'ready',
      sessionId: SESSION_ID,
      start: {
        stage: 'ready',
        sandbox: { external_id: 'sandbox-external-1' },
        opencode_session_id: null,
        retriable: false,
      },
      retryable: false,
    };
  },
  continueSession: async () => 'delivered',
  restartSession: async () => ({ status: 202, body: {} }),
  stopSession: async () => ({ status: 200, body: {} }),
}));

const { projectsApp } = await import('../lib/app');
await import('./r8');

beforeEach(() => {
  storedMetadata = { ...STALE_METADATA };
  metadataReads = [];
  writeDuringPoll = null;
  startCalls = 0;
});

afterAll(() => {
  mock.restore();
});

function start() {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/start?wait_ms=8000`, {
    method: 'POST',
  });
}

test('POST .../start returns the acp_session_id written while the long poll was open', async () => {
  writeDuringPoll = 'codex-native-winner';

  const response = await start();

  expect(response.status).toBe(200);
  expect(startCalls).toBe(1);
  expect(await response.json()).toMatchObject({
    runtime_transport: 'acp',
    runtime_harness: 'codex',
    acp_server_id: SESSION_ID,
    acp_session_id: 'codex-native-winner',
  });
  expect(metadataReads).toEqual([
    {
      runtime_transport: 'acp',
      runtime_harness: 'codex',
      acp_server_id: SESSION_ID,
      acp_session_id: 'codex-native-winner',
    },
  ]);
});

test('POST .../start still returns a null acp_session_id when no writer minted one', async () => {
  const response = await start();

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    acp_server_id: SESSION_ID,
    acp_session_id: null,
  });
});
