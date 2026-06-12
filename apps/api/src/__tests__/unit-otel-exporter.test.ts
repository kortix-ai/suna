import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { emitOtelSpan, isOtelTraceExporterConfigured } from '../lib/otel';
import { runWithContext, setContextField } from '../lib/request-context';

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; init: RequestInit; body: any }> = [];

describe('OTLP trace exporter', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://otel.example.test/v1/traces';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test-token';
    process.env.INTERNAL_KORTIX_ENV = 'dev';
    process.env.SANDBOX_VERSION = 'test-version';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      fetchCalls.push({ url: String(url), init: init ?? {}, body });
      return new Response('', { status: 204 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.INTERNAL_KORTIX_ENV;
    delete process.env.SANDBOX_VERSION;
  });

  test('exports request spans with normalized trace and resource attributes', async () => {
    expect(isOtelTraceExporterConfigured()).toBe(true);

    await runWithContext(
      'GET',
      '/v1/projects/project-1/sessions/session-1',
      async () => {
        setContextField('accountId', 'account-1');
        setContextField('projectId', 'project-1');
        setContextField('sessionId', 'session-1');
        const ok = await emitOtelSpan({
          name: 'GET /v1/projects/project-1/sessions/session-1',
          kind: 'SERVER',
          startTimeMs: 1_000,
          endTimeMs: 1_050,
          attributes: {
            'http.status_code': 200,
            'http.response.duration_ms': 50,
          },
        });
        expect(ok).toBe(true);
      },
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://otel.example.test/v1/traces');
    expect((fetchCalls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');

    const span = fetchCalls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(span.parentSpanId).toBe('bbbbbbbbbbbbbbbb');
    expect(span.name).toBe('GET /v1/projects/project-1/sessions/session-1');
    expect(span.kind).toBe(2);
    expect(span.startTimeUnixNano).toBe('1000000000');
    expect(span.endTimeUnixNano).toBe('1050000000');
    expect(span.attributes).toContainEqual({ key: 'account_id', value: { stringValue: 'account-1' } });
    expect(span.attributes).toContainEqual({ key: 'project_id', value: { stringValue: 'project-1' } });
    expect(span.attributes).toContainEqual({ key: 'session_id', value: { stringValue: 'session-1' } });
    expect(span.attributes).toContainEqual({ key: 'http.status_code', value: { intValue: '200' } });
  });

  test('does not export when no endpoint is configured', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    await runWithContext('GET', '/v1/health', async () => {
      const ok = await emitOtelSpan({
        name: 'GET /v1/health',
        kind: 'SERVER',
        startTimeMs: 1,
      });
      expect(ok).toBe(false);
    });

    expect(fetchCalls).toHaveLength(0);
  });
});
