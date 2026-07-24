import { describe, expect, test } from 'bun:test';
import { mapGatewayLogToGeneration } from './generation-mapper';

function baseRow() {
  return {
    requestId: 'req_abc123',
    resolvedModel: 'anthropic/claude-sonnet-5',
    requestedModel: 'glm-5.2',
    provider: 'bedrock',
    streaming: false,
    inputTokens: 120,
    outputTokens: 340,
    cachedTokens: 40,
    finalCost: '0.012345',
    upstreamCost: '0.010000',
    latencyMs: 812,
    attempts: 1,
    status: 200,
    ok: true,
    errorCode: null,
    createdAt: new Date('2026-07-17T10:00:00.000Z'),
  };
}

describe('mapGatewayLogToGeneration', () => {
  test('maps a successful non-streaming row to the OpenRouter-parity shape', () => {
    const result = mapGatewayLogToGeneration(baseRow());

    expect(result).toEqual({
      id: 'req_abc123',
      model: 'anthropic/claude-sonnet-5',
      requested_model: 'glm-5.2',
      provider: 'bedrock',
      streamed: false,
      tokens_prompt: 120,
      tokens_completion: 340,
      tokens_cached: 40,
      total_cost: 0.012345,
      upstream_cost: 0.01,
      latency_ms: 812,
      attempts: 1,
      status: 200,
      ok: true,
      finish_reason: null,
      created_at: '2026-07-17T10:00:00.000Z',
    });
  });

  test('coerces numeric-string cost columns (Postgres numeric) to numbers', () => {
    const row = { ...baseRow(), finalCost: '1.5', upstreamCost: '1.25' };

    const result = mapGatewayLogToGeneration(row);

    expect(result.total_cost).toBe(1.5);
    expect(result.upstream_cost).toBe(1.25);
    expect(typeof result.total_cost).toBe('number');
  });

  test('surfaces errorCode as finish_reason for a failed call', () => {
    const row = { ...baseRow(), ok: false, status: 502, errorCode: 'upstream_error' };

    const result = mapGatewayLogToGeneration(row);

    expect(result.finish_reason).toBe('upstream_error');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
  });

  test('passes through a string createdAt unchanged (already-serialized row)', () => {
    const row = { ...baseRow(), createdAt: '2026-01-01T00:00:00.000Z' };

    const result = mapGatewayLogToGeneration(row);

    expect(result.created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  test('reflects streaming flag through to streamed', () => {
    const row = { ...baseRow(), streaming: true };

    const result = mapGatewayLogToGeneration(row);

    expect(result.streamed).toBe(true);
  });
});
