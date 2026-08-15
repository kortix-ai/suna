import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import * as realComputeMetering from '../../../billing/services/compute-metering';
import * as realProviders from '../../../platform/providers';
import * as realSandboxProxyBackend from '../../../sandbox-proxy/backend';

let sandboxRow: Record<string, unknown> | null = null;
let stopCalls: string[] = [];
let stopError: Error | null = null;
let pausedCompute: string[] = [];
let cacheInvalidations: string[] = [];
let updateCalls: Array<{
  table: unknown;
  updates: Record<string, unknown>;
  inTransaction: boolean;
}> = [];
let inTransaction = false;

// ── Pre-stop abort call (T11): the daemon fetch is the only real
// I/O `abortLiveTurnBeforeStop` still performs once resolveServiceKey /
// resolveSandboxIngress are stubbed below, so intercepting `fetch` is enough
// to observe and control it without a real network call.
let callOrder: string[] = [];
let abortServiceKey: string | null = 'daemon-service-key';
let abortFetchCalls: Array<{ url: string; init: Record<string, unknown> }> = [];
let abortFetchImpl: (url: string, init: Record<string, unknown>) => Promise<Response> = async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });
const originalFetch = globalThis.fetch;

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
      callOrder.push('provider.stop');
      stopCalls.push(externalId);
      if (stopError) throw stopError;
    },
  }),
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
// Only `resolveServiceKey` / `resolveSandboxIngress` are overridden — those are
// the two calls `abortLiveTurnBeforeStop` makes before its own `fetch`.
mock.module('../../../sandbox-proxy/backend', () => ({
  ...realSandboxProxyBackend,
  resolveServiceKey: async (_externalId: string) => abortServiceKey,
  resolveSandboxIngress: async (_ref: string, _req: unknown) => ({
    url: 'https://daemon.example.test',
    headers: {},
    effectivePort: 8000,
    websocket: false,
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

  callOrder = [];
  abortServiceKey = 'daemon-service-key';
  abortFetchCalls = [];
  abortFetchImpl = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    callOrder.push('abort');
    const record = { url: String(url), init: (init ?? {}) as Record<string, unknown> };
    abortFetchCalls.push(record);
    return abortFetchImpl(record.url, record.init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('stopSession', () => {
  test('404s when the session has no sandbox row', async () => {
    const result = await stopSession(baseInput);
    expect(result.status).toBe(404);
    expect(stopCalls).toEqual([]);
  });

  test('409s when the sandbox is not currently active', async () => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'daytona',
      status: 'stopped',
      metadata: {},
    };
    const result = await stopSession(baseInput);
    expect(result.status).toBe(409);
    expect(stopCalls).toEqual([]);
  });

  test('cancels an in-progress stopped-row wake and guards against a late provider start', async () => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'platinum',
      status: 'stopped',
      metadata: {
        runtimeWakeId: 'wake-1',
        runtimeWakeStartedAt: new Date().toISOString(),
        runtimeWakeLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    };

    const result = await stopSession(baseInput);

    expect(result.status).toBe(200);
    expect(stopCalls).toEqual(['ext-1']);
    expect(pausedCompute).toEqual(['sess-1']);
    // Already-stopped row (a wake was mid-flight, not a live turn) — no live
    // opencode process to abort, so no pre-stop call is attempted.
    expect(abortFetchCalls).toEqual([]);
    const metadata = updateCalls.find((c) => c.table === sessionSandboxes)?.updates.metadata;
    const rendered = describeSql(metadata);
    expect(rendered).toContain('runtimeWakeId');
    expect(rendered).toContain('runtimeWakeLeaseExpiresAt');
    expect(rendered).toContain('runtimeWakeCleanupUntilAt');
    expect(rendered).toContain('manual');
  });

  test('400s for an unsupported/unallowed provider', async () => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'justavps',
      status: 'active',
      metadata: {},
    };
    const result = await stopSession(baseInput);
    expect(result.status).toBe(400);
    expect(stopCalls).toEqual([]);
  });

  test('stops the provider sandbox, closes billing, and marks both rows stopped', async () => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'daytona',
      status: 'active',
      metadata: { foo: 'bar' },
    };
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
    // The wake fence is deleted in SQL so a late provider start cannot revive
    // the stopped session. Unrelated concurrent metadata remains untouched.
    expect(rendered).toContain('runtimeWakeId');
    expect(rendered).not.toContain('lastTurnAt');
  });

  test('reconciles the row as stopped even if the provider says it is already gone', async () => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'daytona',
      status: 'active',
      metadata: {},
    };
    stopError = new Error('sandbox already stopped');
    const result = await stopSession(baseInput);

    expect(result.status).toBe(200);
    expect(
      updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
    ).toBe(true);
  });

  test('commits the stop when provider start is still transitioning', async () => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'platinum',
      status: 'active',
      metadata: { runtimeWakeId: 'wake-1' },
    };
    stopError = new Error('sandbox state change in progress');

    const result = await stopSession(baseInput);

    expect(result.status).toBe(200);
    expect(pausedCompute).toEqual(['sess-1']);
    expect(
      updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
    ).toBe(true);
  });

  test('502s on a genuine provider failure and leaves the rows untouched', async () => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'daytona',
      status: 'active',
      metadata: {},
    };
    stopError = new Error('provider unreachable');
    stopError.message = 'internal provider error: connection refused';
    const result = await stopSession(baseInput);

    expect(result.status).toBe(502);
    expect(updateCalls).toEqual([]);
    expect(pausedCompute).toEqual([]);
  });

  // T11: close the turn before the box loses power.
  describe('pre-stop abort', () => {
    test('issues the daemon abort BEFORE provider.stop() on a running box', async () => {
      sandboxRow = {
        sandboxId: 'sess-1',
        externalId: 'ext-1',
        provider: 'daytona',
        status: 'active',
        metadata: {},
      };

      const result = await stopSession(baseInput);

      expect(result.status).toBe(200);
      expect(abortFetchCalls).toHaveLength(1);
      expect(abortFetchCalls[0]?.url).toBe('https://daemon.example.test/kortix/abort');
      expect(abortFetchCalls[0]?.init.method).toBe('POST');
      // Ordering: the abort call happens strictly before provider.stop().
      expect(callOrder).toEqual(['abort', 'provider.stop']);
    });

    test('a timed-out/failed abort still stops the box (best-effort, never a gate)', async () => {
      sandboxRow = {
        sandboxId: 'sess-1',
        externalId: 'ext-1',
        provider: 'daytona',
        status: 'active',
        metadata: {},
      };
      abortFetchImpl = async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      };

      const result = await stopSession(baseInput);

      expect(result.status).toBe(200);
      expect(abortFetchCalls).toHaveLength(1);
      expect(callOrder).toEqual(['abort', 'provider.stop']);
      expect(stopCalls).toEqual(['ext-1']);
      expect(
        updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
      ).toBe(true);
    });

    test('a non-2xx abort response still stops the box', async () => {
      sandboxRow = {
        sandboxId: 'sess-1',
        externalId: 'ext-1',
        provider: 'daytona',
        status: 'active',
        metadata: {},
      };
      abortFetchImpl = async () => new Response('{"ok":false}', { status: 502 });

      const result = await stopSession(baseInput);

      expect(result.status).toBe(200);
      expect(callOrder).toEqual(['abort', 'provider.stop']);
    });

    test('an unreachable box (no service key on record) skips the fetch entirely and still stops', async () => {
      sandboxRow = {
        sandboxId: 'sess-1',
        externalId: 'ext-1',
        provider: 'daytona',
        status: 'active',
        metadata: {},
      };
      abortServiceKey = null;

      const result = await stopSession(baseInput);

      expect(result.status).toBe(200);
      expect(abortFetchCalls).toEqual([]);
      expect(stopCalls).toEqual(['ext-1']);
    });

    test('an already-stopped box (409 path) never attempts the abort', async () => {
      sandboxRow = {
        sandboxId: 'sess-1',
        externalId: 'ext-1',
        provider: 'daytona',
        status: 'stopped',
        metadata: {},
      };

      const result = await stopSession(baseInput);

      expect(result.status).toBe(409);
      expect(abortFetchCalls).toEqual([]);
    });
  });
});
