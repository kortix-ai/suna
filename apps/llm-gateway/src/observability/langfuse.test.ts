import { describe, expect, test } from 'bun:test';

import type { GatewayTrace } from '@kortix/llm-gateway';
import { traceToLangfuse } from './langfuse';

function trace(over: Partial<GatewayTrace> = {}): GatewayTrace {
  return {
    requestId: 'req_1',
    startedAt: '2026-01-01T00:00:00.000Z',
    accountId: '11111111-1111-1111-1111-111111111111',
    actorUserId: '22222222-2222-2222-2222-222222222222',
    workspaceId: 'p1',
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
    usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2, cacheWriteTokens: 0 },
    upstreamCost: 0.01,
    finalCost: 0.02,
    request: { a: 1 },
    response: { b: 2 },
    metadata: { tag: 't' },
    ...over,
  };
}

describe('traceToLangfuse', () => {
  test('maps a full trace into trace + generation payloads', () => {
    const { trace: t, generation } = traceToLangfuse(trace());
    expect(t.id).toBe('req_1');
    expect(t.userId).toBe('22222222-2222-2222-2222-222222222222');
    expect(t.sessionId).toBe('p1');
    expect(t.timestamp).toBeInstanceOf(Date);
    expect(t.tags).toEqual(['openrouter', 'credits']);

    expect(generation.model).toBe('anthropic/x');
    expect(generation.usageDetails).toEqual({
      input: 10,
      output: 5,
      cache_read_input_tokens: 2,
      total: 15,
    });
    expect(generation.costDetails).toEqual({ total: 0.02 });
    expect(generation.level).toBe('DEFAULT');
    expect(generation.endTime).toBeInstanceOf(Date);
    expect((generation.endTime as Date).getTime() - (generation.startTime as Date).getTime()).toBe(12);
  });

  test('marks failed requests as ERROR level with a status message', () => {
    const { generation } = traceToLangfuse(
      trace({ ok: false, status: 502, errorCode: 'upstream_error', errorMessage: 'boom' }),
    );
    expect(generation.level).toBe('ERROR');
    expect(generation.statusMessage).toBe('boom');
  });

  test('tags streaming requests and falls back to account session', () => {
    const { trace: t } = traceToLangfuse(trace({ streaming: true, workspaceId: undefined }));
    expect(t.tags).toContain('streaming');
    expect(t.sessionId).toBe('11111111-1111-1111-1111-111111111111');
  });

  test('preserves ordered candidate failures in trace and generation metadata', () => {
    const attemptFailures = [
      {
        attempt: 1,
        provider: 'openai-codex',
        routeModel: 'codex/gpt-5.6-sol',
        resolvedModel: 'gpt-5.6-sol',
        stage: 'stream_error' as const,
        status: 400,
        code: 'context_length_exceeded',
        message: 'context rejected',
      },
    ];
    const { trace: t, generation } = traceToLangfuse(trace({ attemptFailures }));
    expect(t.metadata).toMatchObject({
      attemptFailures,
      failureCount: 1,
      fallbackRecovered: true,
    });
    expect(generation.metadata).toMatchObject({ attemptFailures, failureCount: 1 });
  });
});
