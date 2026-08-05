import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import * as realProviders from '../../../platform/providers';
import * as realComputeMetering from '../../../billing/services/compute-metering';

let sandboxRow: Record<string, unknown> | null = null;
let stopCalls: string[] = [];
let stopError: Error | null = null;
let pausedCompute: string[] = [];
let cacheInvalidations: string[] = [];
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown>; inTransaction: boolean }> = [];
let inTransaction = false;

/** Flatten a drizzle SQL expression (including its bound params) to text, so a
 *  test can assert what the write actually asks Postgres to do. */
function describeSql(expression: unknown): string {
  const chunks: unknown[] = (expression as any)?.queryChunks ?? [];
  return chunks
    .map((chunk: any) => {
      if (typeof chunk === 'string') return chunk;
      if (Array.isArray(chunk?.value)) return chunk.value.join('');
      if (typeof chunk?.value === 'string') return chunk.value;
      return chunk?.name ?? '';
    })
    .join(' ');
}

mock.module('../../../config', () => ({
  config: { ALLOWED_SANDBOX_PROVIDERS: ['daytona', 'platinum'] },
}));

const updater = (table: unknown) => ({
  set: (updates: Record<string, unknown>) => ({
    where: async () => {
      updateCalls.push({ table, updates, inTransaction });
    },
  }),
});

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      inTransaction = true;
      try {
        return await fn({ update: updater });
      } finally {
        inTransaction = false;
      }
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === sessionSandboxes && sandboxRow ? [sandboxRow] : []),
        }),
      }),
    }),
    update: updater,
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../../platform/providers', () => ({
  ...realProviders,
  getProvider: (_name: string) => ({
    stop: async (externalId: string) => {
      stopCalls.push(externalId);
      if (stopError) throw stopError;
    },
  }),
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../../billing/services/compute-metering', () => ({
  ...realComputeMetering,
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
  inTransaction = false;
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
    const rendered = describeSql(sandboxUpdate?.updates.metadata);
    expect(rendered).toContain('stoppedBy');
    expect(rendered).toContain('user-1');
    expect(rendered).toContain('manual');

    const sessionUpdate = updateCalls.find((c) => c.table === projectSessions);
    expect(sessionUpdate?.updates.status).toBe('stopped');
    // Both flips in one transaction — the box is never parked while the session
    // still claims to be running.
    expect(sandboxUpdate?.inTransaction).toBe(true);
    expect(sessionUpdate?.inTransaction).toBe(true);
  });

  // The lost update. This path used to write
  // `metadata: { ...sandbox.metadata, stoppedAt, stoppedBy, stopReason }` — a
  // whole object assembled from the SELECT at the top of stopSession, which
  // re-sends every key as it looked THEN. Anything a concurrent writer put in
  // the column in between is silently reverted, and two live writers do exactly
  // that: projects/routes/shared.ts sets and clears the `runtimeWakeId` wake
  // fence on the resume path. Under the old code `updates.metadata` is a plain
  // object carrying `runtimeWakeId` and every assertion below fails.
  test('REGRESSION: the stop patch is merged into jsonb, never rebuilt from the row it read', async () => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'daytona',
      status: 'active',
      metadata: { runtimeWakeId: 'wake-1', lastTurnAt: '2026-07-29T11:00:00.000Z' },
    };

    const result = await stopSession(baseInput);
    expect(result.status).toBe(200);

    const metadata = updateCalls.find((c) => c.table === sessionSandboxes)?.updates.metadata;
    // A jsonb merge expression, not an object literal.
    expect(Array.isArray((metadata as any)?.queryChunks)).toBe(true);
    const rendered = describeSql(metadata);
    expect(rendered).toContain('coalesce');
    expect(rendered).toContain("'{}'::jsonb");
    expect(rendered).toContain('stopReason');
    // The keys it read are left for the DB to keep — never re-sent, so a
    // concurrent write to either of them survives this stop.
    expect(rendered).not.toContain('runtimeWakeId');
    expect(rendered).not.toContain('lastTurnAt');
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
