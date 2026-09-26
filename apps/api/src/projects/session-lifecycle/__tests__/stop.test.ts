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
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];

// ── Pre-stop abort call (T11): the daemon fetch is the only real
// I/O `abortLiveTurnBeforeStop` still performs once resolveServiceKey /
// resolveSandboxIngress are stubbed below, so intercepting `fetch` is enough
// to observe and control it without a real network call.
let callOrder: string[] = [];
/** What scope each awaited stop-time capture asked for. */
let captureScopes: Array<string | undefined> = [];
let abortServiceKey: string | null = 'daemon-service-key';
let abortFetchCalls: Array<{ url: string; init: Record<string, unknown> }> = [];
let abortFetchImpl: (url: string, init: Record<string, unknown>) => Promise<Response> = async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });
const originalFetch = globalThis.fetch;

mock.module('../../../config', () => ({
  config: { ALLOWED_SANDBOX_PROVIDERS: ['daytona', 'platinum'] },
}));

const updater = (table: unknown) => ({
  set: (updates: Record<string, unknown>) => ({
    // Awaitable, and chainable to `.returning()` (the status transitions).
    where: () => {
      updateCalls.push({ table, updates });
      const result = Promise.resolve([{ sandboxId: 'moved', sessionId: 'moved' }]);
      return Object.assign(result, { returning: () => result });
    },
  }),
});

// The real applyStoppedState runs against this stub. Its SQL and its
// transaction are proven on real rows in
// __tests__/integration-session-status-transitions.test.ts.
const executor = async () => {};

const transactionScope: Record<string, unknown> = {
  update: updater,
  execute: executor,
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(transactionScope),
};

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(transactionScope),
    execute: executor,
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

mock.module('../../lib/session-transcript-capture', () => ({
  captureSessionTranscriptMirror: async (
    sessionId: string,
    _deps?: unknown,
    options?: { scope?: string },
  ) => {
    callOrder.push(`capture:${sessionId}`);
    captureScopes.push(options?.scope);
    return null;
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

  callOrder = [];
  captureScopes = [];
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
    // The 409 returns before the pre-stop abort.
    expect(abortFetchCalls).toEqual([]);
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
    expect(callOrder).toEqual(['provider.stop']);
    // The persisted late-start guard is read back on real rows in
    // integration-session-status-transitions ("manual stop").
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

    // The stop went through the single stop writer (applyStoppedState).
    expect(updateCalls.find((c) => c.table === sessionSandboxes)?.updates.status).toBe('stopped');
    expect(updateCalls.find((c) => c.table === projectSessions)?.updates.status).toBe('stopped');
  });

  // A provider that already stopped the box, or is still mid-transition,
  // tolerates the stop: the row is reconciled as stopped.
  test.each([
    ['says the box is already stopped', 'sandbox already stopped'],
    ['is still transitioning', 'sandbox state change in progress'],
  ])('commits the stop when the provider %s', async (_label, message) => {
    sandboxRow = {
      sandboxId: 'sess-1',
      externalId: 'ext-1',
      provider: 'platinum',
      status: 'active',
      metadata: {},
    };
    stopError = new Error(message);

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
      expect(callOrder).toEqual(['abort', 'capture:sess-1', 'provider.stop']);
      // And it asks for a TAIL. This capture is AWAITED with the user holding
      // the Stop button; on a project with `session_transcript_history` the
      // default scope is a 60s pagination with three retries. The whole copy is
      // maintained at every turn end, so the only gap a stop can close is the
      // turn that just ended.
      expect(captureScopes).toEqual(['tail']);
    });
  });
});
