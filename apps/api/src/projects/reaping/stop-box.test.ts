import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realSandboxProxyBackend from '../../sandbox-proxy/backend';

// T11: close the live opencode turn on a box BEFORE `provider.stop()`
// powers it off, via `abortLiveTurnBeforeStop` (exported alongside
// `stopExpiredBox` in stop-box.ts, and reused by session-lifecycle/stop.ts —
// see its own coverage in session-lifecycle/__tests__/stop.test.ts).
//
// Every module `stopExpiredBox` touches is stubbed here so a test can assert
// call ORDER (abort strictly before provider.stop) and that a failed/timed-out/
// unreachable abort never blocks the stop it precedes.

let deadlineAtOverride: Date | null = null;
let reloadDeadlineCalls: string[] = [];
let providerStopCalls: string[] = [];
let providerStopError: Error | null = null;
let applyStoppedCalls: Array<Record<string, unknown>> = [];
let callOrder: string[] = [];

let abortServiceKey: string | null = 'daemon-service-key';
let abortFetchCalls: Array<{ url: string; init: Record<string, unknown> }> = [];
let abortFetchImpl: (url: string, init: Record<string, unknown>) => Promise<Response> = async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });
const originalFetch = globalThis.fetch;

mock.module('./box-queries', () => ({
  reloadDeadlineAt: async (sandboxId: string) => {
    reloadDeadlineCalls.push(sandboxId);
    return deadlineAtOverride;
  },
}));

mock.module('../../platform/providers', () => ({
  getProvider: (_name: string) => ({
    stop: async (externalId: string) => {
      callOrder.push('provider.stop');
      providerStopCalls.push(externalId);
      if (providerStopError) throw providerStopError;
    },
  }),
}));

mock.module('./sandbox-state-sync', () => ({
  applyStoppedState: async (input: Record<string, unknown>) => {
    applyStoppedCalls.push(input);
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
// Only `resolveServiceKey` / `resolveSandboxIngress` are overridden — those are
// the two calls `abortLiveTurnBeforeStop` makes before its own `fetch`.
mock.module('../../sandbox-proxy/backend', () => ({
  ...realSandboxProxyBackend,
  resolveServiceKey: async (_externalId: string) => abortServiceKey,
  resolveSandboxIngress: async (_ref: string, _req: unknown) => ({
    url: 'https://daemon.example.test',
    headers: {},
    effectivePort: 8000,
    websocket: false,
  }),
}));

const { stopExpiredBox } = await import('./stop-box');

const row = {
  sandboxId: 'sb-1',
  sessionId: 'sess-1',
  externalId: 'ext-1',
  provider: 'daytona' as const,
};

const NOW = new Date('2026-08-15T00:05:00.000Z');

beforeEach(() => {
  // Expired by default — the shape most calls into stopExpiredBox arrive in.
  // Compared against the REAL clock (Date.now()), not the `now` fixture: the
  // implementation's skip gate reads live time, only the write uses `now`.
  deadlineAtOverride = new Date(Date.now() - 60_000);
  reloadDeadlineCalls = [];
  providerStopCalls = [];
  providerStopError = null;
  applyStoppedCalls = [];
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

describe('stopExpiredBox — pre-stop abort', () => {
  test('a deadline that is no longer expired skips reaping and never attempts the abort', async () => {
    deadlineAtOverride = new Date(Date.now() + 60_000);

    const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

    expect(outcome).toBe('skipped');
    expect(abortFetchCalls).toEqual([]);
    expect(providerStopCalls).toEqual([]);
  });

  test('issues the daemon abort BEFORE provider.stop() for an expired box', async () => {
    const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

    expect(outcome).toBe('stopped');
    expect(reloadDeadlineCalls).toEqual(['sb-1']);
    expect(abortFetchCalls).toHaveLength(1);
    expect(abortFetchCalls[0]?.url).toBe('https://daemon.example.test/kortix/abort');
    expect(abortFetchCalls[0]?.init.method).toBe('POST');
    // Ordering: the abort call happens strictly before provider.stop().
    expect(callOrder).toEqual(['abort', 'provider.stop']);
    expect(applyStoppedCalls).toHaveLength(1);
    expect(applyStoppedCalls[0]?.stopReason).toBe('deadline_expired');
  });

  test('a timed-out/failed abort still stops the box (best-effort, never a gate)', async () => {
    abortFetchImpl = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };

    const outcome = await stopExpiredBox(row, NOW, 'run_cap');

    expect(outcome).toBe('stopped');
    expect(abortFetchCalls).toHaveLength(1);
    expect(callOrder).toEqual(['abort', 'provider.stop']);
    expect(providerStopCalls).toEqual(['ext-1']);
  });

  test('a non-2xx abort response still stops the box', async () => {
    abortFetchImpl = async () => new Response('{"ok":false}', { status: 502 });

    const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

    expect(outcome).toBe('stopped');
    expect(callOrder).toEqual(['abort', 'provider.stop']);
  });

  test('no service key on record skips the fetch entirely and still stops', async () => {
    abortServiceKey = null;

    const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

    expect(outcome).toBe('stopped');
    expect(abortFetchCalls).toEqual([]);
    expect(providerStopCalls).toEqual(['ext-1']);
  });

  test('a genuine provider.stop failure still reports errors, independent of the abort outcome', async () => {
    providerStopError = new Error('provider unreachable');
    const warn = console.error;
    console.error = () => {};
    try {
      const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');
      expect(outcome).toBe('errors');
    } finally {
      console.error = warn;
    }

    expect(abortFetchCalls).toHaveLength(1);
    expect(applyStoppedCalls).toEqual([]);
  });
});
