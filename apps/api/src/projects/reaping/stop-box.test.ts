import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { logger } from '../../lib/logger';
import * as realSandboxProxyBackend from '../../sandbox-proxy/backend';
import * as realEphemeralSandbox from '../../platform/services/ephemeral-sandbox';

// T11: close the live opencode turn on a box BEFORE `provider.stop()`
// powers it off, via `abortLiveTurnBeforeStop` (exported alongside
// `stopExpiredBox` in stop-box.ts, and reused by session-lifecycle/stop.ts —
// see its own coverage in session-lifecycle/__tests__/stop.test.ts).
//
// Every module `stopExpiredBox` touches is stubbed here so a test can assert
// call ORDER (abort strictly before provider.stop) and that a failed/timed-out/
// unreachable abort never blocks the stop it precedes.

let stopClaimGranted = true;
let stopClaimCalls: Array<{ sandboxId: string; token: string }> = [];
let stopClaimReleaseCalls: Array<{ sandboxId: string; token: string }> = [];
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
  claimExpiredSandboxStop: async (sandboxId: string, token: string) => {
    stopClaimCalls.push({ sandboxId, token });
    return stopClaimGranted;
  },
  releaseSandboxStopClaim: async (sandboxId: string, token: string) => {
    stopClaimReleaseCalls.push({ sandboxId, token });
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

// None of these boxes is ephemeral: no retire plan, so the stop takes the
// normal path without a database read.
mock.module('../../platform/services/ephemeral-sandbox', () => ({
  ...realEphemeralSandbox,
  retireOnStopPlan: async () => null,
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
  stopClaimGranted = true;
  stopClaimCalls = [];
  stopClaimReleaseCalls = [];
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
    stopClaimGranted = false;

    const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

    expect(outcome).toBe('skipped');
    expect(abortFetchCalls).toEqual([]);
    expect(providerStopCalls).toEqual([]);
  });

  test('issues the daemon abort BEFORE provider.stop() for an expired box', async () => {
    const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

    expect(outcome).toBe('stopped');
    expect(stopClaimCalls).toEqual([{ sandboxId: 'sb-1', token: expect.any(String) }]);
    expect(abortFetchCalls).toHaveLength(1);
    expect(abortFetchCalls[0]?.url).toBe('https://daemon.example.test/kortix/abort');
    expect(abortFetchCalls[0]?.init.method).toBe('POST');
    // Ordering: the abort call happens strictly before provider.stop().
    expect(callOrder).toEqual(['abort', 'provider.stop']);
    expect(applyStoppedCalls).toHaveLength(1);
    expect(applyStoppedCalls[0]?.stopReason).toBe('deadline_expired');
  });

  // The abort is best-effort, never a gate: every way it can fail still stops
  // the box. The same helper runs before the manual stop
  // (session-lifecycle/stop.ts), so this table is its one owner.
  test.each([
    {
      name: 'a timed-out abort',
      setup: () => {
        abortFetchImpl = async () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        };
      },
      aborts: 1,
    },
    {
      name: 'a non-2xx abort response',
      setup: () => {
        abortFetchImpl = async () => new Response('{"ok":false}', { status: 502 });
      },
      aborts: 1,
    },
    {
      name: 'no service key on record (no fetch at all)',
      setup: () => {
        abortServiceKey = null;
      },
      aborts: 0,
    },
  ])('$name still stops the box', async ({ setup, aborts }) => {
    setup();

    const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

    expect(outcome).toBe('stopped');
    expect(abortFetchCalls).toHaveLength(aborts);
    expect(callOrder).toEqual([...(aborts ? ['abort'] : []), 'provider.stop']);
    expect(providerStopCalls).toEqual(['ext-1']);
  });

  // KRTX-619: a bulk idle-reap stops a cohort at once; each box whose daemon is
  // already going down rejects with `TimeoutError: The operation timed out.`.
  // That is an expected miss (the abort never gates the stop), so it ships at
  // info. A warn per box turned a routine reaper backlog into a log spike.
  test('an unreachable daemon (timeout) is an expected miss: info, never warn', async () => {
    abortFetchImpl = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    const infoSpy = mock(() => {});
    const warnSpy = mock(() => {});
    const origInfo = logger.info;
    const origWarn = console.warn;
    logger.info = infoSpy as unknown as typeof logger.info;
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

      expect(outcome).toBe('stopped');
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logger.info = origInfo;
      console.warn = origWarn;
    }
  });

  test('a non-timeout abort failure stays a warning', async () => {
    abortFetchImpl = async () => {
      throw new Error('ingress resolution exploded');
    };
    const infoSpy = mock(() => {});
    const warnSpy = mock(() => {});
    const origInfo = logger.info;
    const origWarn = console.warn;
    logger.info = infoSpy as unknown as typeof logger.info;
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');

      expect(outcome).toBe('stopped');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      logger.info = origInfo;
      console.warn = origWarn;
    }
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
    expect(stopClaimReleaseCalls).toEqual([{ sandboxId: 'sb-1', token: stopClaimCalls[0]?.token }]);
  });

  // KRTX-667: Platinum's own `stopping` transition outlasts stop()'s 10s
  // confirm bound. The stop was accepted and the VM is on its way down, so this
  // is the lifecycle transition, not a failure: release the claim, retry next
  // pass, and do NOT page an error per box in an idle-reap cohort.
  test('a Platinum stop-confirm timeout while still stopping is a transition, not an error', async () => {
    providerStopError = new Error(
      'Platinum stop for sbx_1 did not reach stopped within 10000ms (last state: stopping)',
    );
    const errorSpy = mock(() => {});
    const origError = console.error;
    console.error = errorSpy as unknown as typeof console.error;
    try {
      const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');
      expect(outcome).toBe('skipped');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      console.error = origError;
    }

    expect(applyStoppedCalls).toEqual([]);
    expect(stopClaimReleaseCalls).toEqual([{ sandboxId: 'sb-1', token: stopClaimCalls[0]?.token }]);
  });

  // A last state of `running` means the stop did not take. That is a real
  // failure, so the classifier must not swallow it.
  test('a Platinum stop-confirm timeout with the VM still running stays an error', async () => {
    providerStopError = new Error(
      'Platinum stop for sbx_1 did not reach stopped within 10000ms (last state: running)',
    );
    const errorSpy = mock(() => {});
    const origError = console.error;
    console.error = errorSpy as unknown as typeof console.error;
    try {
      const outcome = await stopExpiredBox(row, NOW, 'deadline_expired');
      expect(outcome).toBe('errors');
    } finally {
      console.error = origError;
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(applyStoppedCalls).toEqual([]);
  });
});
