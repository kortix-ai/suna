import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GatewayTrace } from '@kortix/llm-gateway';
import { runWithContext, setContextField } from '../lib/request-context';
import { emitGatewayGenAiSpan } from './hooks';

interface OtelAttributeValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtelAttribute {
  key: string;
  value: OtelAttributeValue;
}

interface OtelSpan {
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtelAttribute[];
}

interface OtlpBody {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: OtelSpan[] }> }>;
}

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; body: OtlpBody }> = [];

function baseTrace(overrides: Partial<GatewayTrace> = {}): GatewayTrace {
  return {
    requestId: 'req_gw_1',
    startedAt: new Date().toISOString(),
    accountId: 'acc_1',
    actorUserId: 'user_1',
    projectId: 'proj_1',
    sessionId: 'sess_1',
    requestedModel: 'claude-sonnet',
    resolvedModel: 'claude-sonnet-4-5',
    provider: 'bedrock',
    billingMode: 'credits',
    streaming: false,
    status: 200,
    ok: true,
    latencyMs: 850,
    attempts: 1,
    candidatesTried: ['claude-sonnet-4-5'],
    usage: { promptTokens: 120, completionTokens: 45, cachedTokens: 10 },
    upstreamCost: 0.002,
    finalCost: 0.003,
    request: {},
    response: {},
    metadata: {},
    ...overrides,
  };
}

function lastSpan(): OtelSpan {
  const call = fetchCalls[fetchCalls.length - 1];
  return call.body.resourceSpans[0].scopeSpans[0].spans[0];
}

function attr(span: OtelSpan, key: string): OtelAttributeValue | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

function attrScalar(span: OtelSpan, key: string): unknown {
  const value = attr(span, key);
  if (!value) return undefined;
  return value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue;
}

async function emitAndFlush(trace: GatewayTrace) {
  await runWithContext('POST', '/v1/llm/chat/completions', async () => {
    setContextField('accountId', 'acc_1');
    emitGatewayGenAiSpan(trace);
    // emitGatewayGenAiSpan is fire-and-forget; give the microtask queue a turn
    // so the underlying emitOtelSpan() promise's fetch() call resolves.
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('emitGatewayGenAiSpan', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://otel.example.test/v1/traces';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as OtlpBody;
      fetchCalls.push({ url: String(url), body });
      return new Response('', { status: 204 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  test('emits a gen_ai span with OTel semantic-convention + kortix custom attributes', async () => {
    await emitAndFlush(baseTrace());

    expect(fetchCalls).toHaveLength(1);
    const span = lastSpan();
    expect(span.name).toBe('chat claude-sonnet-4-5');
    expect(span.kind).toBe(1);

    expect(attrScalar(span, 'gen_ai.system')).toBe('bedrock');
    expect(attrScalar(span, 'gen_ai.operation.name')).toBe('chat');
    expect(attrScalar(span, 'gen_ai.request.model')).toBe('claude-sonnet');
    expect(attrScalar(span, 'gen_ai.response.model')).toBe('claude-sonnet-4-5');
    expect(attrScalar(span, 'gen_ai.usage.input_tokens')).toBe('120');
    expect(attrScalar(span, 'gen_ai.usage.output_tokens')).toBe('45');

    expect(attrScalar(span, 'kortix.cost_usd')).toBe(0.003);
    expect(attrScalar(span, 'kortix.upstream_cost_usd')).toBe(0.002);
    expect(attrScalar(span, 'kortix.provider')).toBe('bedrock');
    expect(attrScalar(span, 'kortix.cached_tokens')).toBe('10');
    expect(attrScalar(span, 'kortix.streaming')).toBe(false);
    expect(attrScalar(span, 'kortix.billing_mode')).toBe('credits');
    expect(attrScalar(span, 'kortix.request_id')).toBe('req_gw_1');
    expect(attrScalar(span, 'kortix.attempts')).toBe('1');
    expect(attrScalar(span, 'kortix.gateway_status')).toBe('200');
    expect(attrScalar(span, 'kortix.ok')).toBe(true);
    expect(attr(span, 'kortix.error_code')).toBeUndefined();
  });

  test('falls back gen_ai.response.model to the requested model when unresolved', async () => {
    await emitAndFlush(baseTrace({ resolvedModel: '' }));

    const span = lastSpan();
    expect(span.name).toBe('chat claude-sonnet');
    expect(attrScalar(span, 'gen_ai.response.model')).toBe('claude-sonnet');
  });

  test('includes kortix.error_code for a failed gateway call', async () => {
    await emitAndFlush(baseTrace({ ok: false, status: 502, errorCode: 'upstream_error' }));

    const span = lastSpan();
    expect(attrScalar(span, 'kortix.error_code')).toBe('upstream_error');
    expect(attrScalar(span, 'kortix.ok')).toBe(false);
  });

  test('computes the span time window from latencyMs', async () => {
    const before = Date.now();
    await emitAndFlush(baseTrace({ latencyMs: 500 }));
    const after = Date.now();

    const span = lastSpan();
    const startMs = Number(BigInt(span.startTimeUnixNano) / 1_000_000n);
    const endMs = Number(BigInt(span.endTimeUnixNano) / 1_000_000n);
    expect(endMs - startMs).toBe(500);
    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after + 5);
  });

  test('never throws and does not export when no OTLP endpoint is configured', () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    expect(() => emitGatewayGenAiSpan(baseTrace())).not.toThrow();
    expect(fetchCalls).toHaveLength(0);
  });

  test('never throws when there is no request context, even if the exporter is configured', () => {
    expect(() => emitGatewayGenAiSpan(baseTrace())).not.toThrow();
  });
});
