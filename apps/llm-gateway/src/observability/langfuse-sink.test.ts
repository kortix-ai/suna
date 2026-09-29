import { beforeEach, describe, expect, mock, test } from 'bun:test';

// `createLangfuseSink` wraps the real `Langfuse` client, which opens a
// network client on construction. Mocked here (before `./langfuse` is ever
// imported) so `status()` can be exercised deterministically — success vs.
// failure, and the streak reset — without a real Langfuse endpoint. This is
// the regression guard for the O1 gap (2026-09-24T17:35Z: Langfuse stopped
// receiving traces platform-wide and nothing surfaced it for ~2.5 days,
// because a failed `record()` only ever reached a `logger.warn` line that
// nothing was reading).
let throwOnTrace: Error | null = null;
mock.module('langfuse', () => ({
  Langfuse: class {
    trace() {
      if (throwOnTrace) throw throwOnTrace;
      return { generation: () => undefined };
    }
    async flushAsync() {}
    async shutdownAsync() {}
  },
}));

const { createLangfuseSink } = await import('./langfuse');

function trace(over: Record<string, unknown> = {}) {
  return {
    requestId: 'req_1',
    startedAt: '2026-01-01T00:00:00.000Z',
    accountId: 'acct_1',
    projectId: 'p1',
    keyId: 'k1',
    requestedModel: 'kortix/x',
    resolvedModel: 'anthropic/x',
    provider: 'openrouter',
    billingMode: 'credits',
    streaming: false,
    status: 200,
    ok: true,
    latencyMs: 12,
    attempts: 1,
    candidatesTried: ['openrouter'],
    usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 },
    upstreamCost: 0.01,
    finalCost: 0.02,
    request: {},
    response: {},
    metadata: {},
    ...over,
    // biome-ignore lint: test fixture cast
  } as Parameters<ReturnType<typeof createLangfuseSink>['record']>[0];
}

describe('createLangfuseSink status', () => {
  beforeEach(() => {
    throwOnTrace = null;
  });

  test('starts with no queued trace and no failure', () => {
    const sink = createLangfuseSink({ publicKey: 'pk', secretKey: 'sk' }, { warn: () => {} });
    expect(sink.status()).toEqual({
      lastQueuedAt: null,
      lastFailureAt: null,
      lastError: null,
      consecutiveFailures: 0,
    });
  });

  test('a successful record sets lastQueuedAt and keeps the streak at 0', async () => {
    const sink = createLangfuseSink({ publicKey: 'pk', secretKey: 'sk' }, { warn: () => {} });
    await sink.record(trace());
    const status = sink.status();
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastQueuedAt).toBeGreaterThan(0);
    expect(status.lastFailureAt).toBeNull();
  });

  test('a failing record never throws out of the sink and counts a streak', async () => {
    throwOnTrace = new Error('ingest rejected');
    const warnings: unknown[][] = [];
    const sink = createLangfuseSink(
      { publicKey: 'pk', secretKey: 'sk' },
      { warn: (...args) => warnings.push(args) },
    );

    await sink.record(trace());
    await sink.record(trace());
    await sink.record(trace());

    const status = sink.status();
    expect(status.consecutiveFailures).toBe(3);
    expect(status.lastError).toBe('ingest rejected');
    expect(status.lastFailureAt).toBeGreaterThan(0);
    expect(status.lastQueuedAt).toBeNull();
    expect(warnings.length).toBe(3);
  });

  test('a success after failures resets the streak — one recovered send is enough', async () => {
    throwOnTrace = new Error('ingest rejected');
    const sink = createLangfuseSink({ publicKey: 'pk', secretKey: 'sk' }, { warn: () => {} });

    await sink.record(trace());
    await sink.record(trace());
    expect(sink.status().consecutiveFailures).toBe(2);

    throwOnTrace = null;
    await sink.record(trace());

    const status = sink.status();
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastQueuedAt).toBeGreaterThan(0);
    // The failure history is not erased — only the streak that decides the
    // health-endpoint incident is.
    expect(status.lastFailureAt).toBeGreaterThan(0);
  });
});
