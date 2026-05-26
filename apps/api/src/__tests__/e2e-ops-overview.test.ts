import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

let executeResults: Array<{ rows: unknown[] }> = [];

mock.module('../shared/db', () => ({
  db: {
    execute: async () => executeResults.shift() ?? { rows: [] },
  },
}));

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', '00000000-0000-4000-a000-000000000001');
    await next();
  },
}));

mock.module('../middleware/require-admin', () => ({
  requireAdmin: async (_c: any, next: any) => {
    await next();
  },
}));

mock.module('../config', () => ({
  config: { KORTIX_BILLING_INTERNAL_ENABLED: false },
}));

mock.module('../tunnel', () => ({
  getTunnelServiceStatus: () => ({ enabled: true, connectedAgents: 2 }),
}));

const { opsApp } = await import('../ops');

function app() {
  const hono = new Hono();
  hono.route('/v1/ops', opsApp);
  return hono;
}

describe('ops overview dashboard API', () => {
  beforeEach(() => {
    process.env.BETTERSTACK_API_LOG_TOKEN = 'log-token-test';
    process.env.BETTERSTACK_API_LOG_HOST = 'logs.example.test';
    process.env.BETTERSTACK_API_SENTRY_DSN = 'https://example@sentry.test/1';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://otel.example.test/v1/traces';
    executeResults = [
      { rows: [{ count: 2 }] },
      { rows: [{ count: 3 }] },
      { rows: [{ count: 1 }] },
      { rows: [{ key: 'running', count: 4 }, { key: 'failed', count: 1 }] },
      { rows: [{ key: 'active', count: 3 }, { key: 'error', count: 1 }] },
      { rows: [{ key: 'daytona', count: 2 }, { key: 'local_docker', count: 2 }] },
      { rows: [{ count: 9 }] },
      { rows: [{ key: 'applied', count: 1 }] },
      {
        rows: [{
          provider: 'openrouter',
          calls: 7,
          input_tokens: 100,
          output_tokens: 50,
          cached_tokens: 10,
          cost_usd: '0.123456',
        }],
      },
      {
        rows: [{
          event_id: '00000000-0000-4000-a000-000000000901',
          account_id: '00000000-0000-4000-a000-000000000101',
          actor_user_id: '00000000-0000-4000-a000-000000000001',
          action: 'POST /v1/projects',
          resource_type: 'project',
          resource_id: '00000000-0000-4000-a000-000000000201',
          occurred_at: new Date('2026-05-15T00:00:00Z'),
        }],
      },
    ];
  });

  test('returns production support signals for API, queues, audit, usage, and migrations', async () => {
    const res = await app().request('/v1/ops/overview');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.api).toEqual({
      status: 'ok',
      billing_enabled: false,
      tunnel: { enabled: true, connectedAgents: 2 },
    });
    expect(body.totals).toMatchObject({
      accounts: 2,
      projects: 3,
      active_legacy_sandboxes: 1,
    });
    expect(body.sessions.by_status).toMatchObject({ running: 4, failed: 1 });
    expect(body.sandboxes.by_provider).toMatchObject({ daytona: 2, local_docker: 2 });
    expect(body.queues.queued_total).toBe(0);
    expect(body.queues.trigger_events_by_status).toEqual({});
    expect(body.audit.events_24h).toBe(9);
    expect(body.audit.recent[0]).toMatchObject({ action: 'POST /v1/projects' });
    expect(body.usage).toMatchObject({
      calls_24h: 7,
      cost_usd_24h: 0.123456,
    });
    expect(body.observability).toEqual({
      managed_logs_configured: true,
      managed_log_host: 'logs.example.test',
      error_tracking_configured: true,
      structured_request_logs_enabled: true,
      trace_headers_enabled: true,
      otlp_exporter_configured: true,
      otlp_request_spans_enabled: true,
    });
    expect(body.migrations.by_status).toMatchObject({ applied: 1 });
  });
});
