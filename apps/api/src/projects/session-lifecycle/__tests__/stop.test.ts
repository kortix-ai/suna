import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';

let sandboxRow: Record<string, unknown> | null = null;
let stopCalls: string[] = [];
let stopError: Error | null = null;
let pausedCompute: string[] = [];
let cacheInvalidations: string[] = [];
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];

mock.module('../../../config', () => ({
  config: { ALLOWED_SANDBOX_PROVIDERS: ['daytona', 'platinum'] },
}));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === sessionSandboxes && sandboxRow ? [sandboxRow] : []),
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

mock.module('../../../platform/providers', () => ({
  getProvider: (_name: string) => ({
    stop: async (externalId: string) => {
      stopCalls.push(externalId);
      if (stopError) throw stopError;
    },
  }),
}));

mock.module('../../../billing/services/compute-metering', () => ({
  reopenComputeForSandbox: async () => undefined,
  pauseComputeSession: async (sandboxId: string) => {
    pausedCompute.push(sandboxId);
  },
  endComputeSession: async () => {},
}));

mock.module('../../../sandbox-proxy', () => ({
  invalidateProviderCache: (externalId: string) => {
    cacheInvalidations.push(externalId);
  },
}));

const { stopSession } = await import('../stop');

const baseInput = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  accountId: 'acct-1',
  userId: 'user-1',
};

beforeEach(() => {
  sandboxRow = null;
  stopCalls = [];
  stopError = null;
  pausedCompute = [];
  cacheInvalidations = [];
  updateCalls = [];
});

describe('stopSession', () => {
  test('404s when the session has no sandbox row', async () => {
    const result = await stopSession(baseInput);
    expect(result.status).toBe(404);
    expect(stopCalls).toEqual([]);
  });

  test('409s when the sandbox is not currently active', async () => {
    sandboxRow = { sandboxId: 'sess-1', externalId: 'ext-1', provider: 'daytona', status: 'stopped', metadata: {} };
    const result = await stopSession(baseInput);
    expect(result.status).toBe(409);
    expect(stopCalls).toEqual([]);
  });

  test('400s for an unsupported/unallowed provider', async () => {
    sandboxRow = { sandboxId: 'sess-1', externalId: 'ext-1', provider: 'justavps', status: 'active', metadata: {} };
    const result = await stopSession(baseInput);
    expect(result.status).toBe(400);
    expect(stopCalls).toEqual([]);
  });

  test('stops the provider sandbox, closes billing, and marks both rows stopped', async () => {
    sandboxRow = { sandboxId: 'sess-1', externalId: 'ext-1', provider: 'daytona', status: 'active', metadata: { foo: 'bar' } };
    const result = await stopSession(baseInput);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, session_id: 'sess-1', status: 'stopped' });
    expect(stopCalls).toEqual(['ext-1']);
    expect(pausedCompute).toEqual(['sess-1']);
    expect(cacheInvalidations).toEqual(['ext-1']);

    const sandboxUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    expect(sandboxUpdate?.updates.status).toBe('stopped');
    expect(sandboxUpdate?.updates.metadata).toMatchObject({
      foo: 'bar',
      stoppedBy: 'user-1',
      stopReason: 'manual',
    });

    const sessionUpdate = updateCalls.find((c) => c.table === projectSessions);
    expect(sessionUpdate?.updates.status).toBe('stopped');
  });

  test('reconciles the row as stopped even if the provider says it is already gone', async () => {
    sandboxRow = { sandboxId: 'sess-1', externalId: 'ext-1', provider: 'daytona', status: 'active', metadata: {} };
    stopError = new Error('sandbox already stopped');
    const result = await stopSession(baseInput);

    expect(result.status).toBe(200);
    expect(updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped')).toBe(true);
  });

  test('502s on a genuine provider failure and leaves the rows untouched', async () => {
    sandboxRow = { sandboxId: 'sess-1', externalId: 'ext-1', provider: 'daytona', status: 'active', metadata: {} };
    stopError = new Error('provider unreachable');
    stopError.message = 'internal provider error: connection refused';
    const result = await stopSession(baseInput);

    expect(result.status).toBe(502);
    expect(updateCalls).toEqual([]);
    expect(pausedCompute).toEqual([]);
  });
});
