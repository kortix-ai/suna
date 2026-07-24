import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

/**
 * Mocked db.execute result queue.
 *
 * Each entry is consumed in `Promise.all` order by the /ops/overview
 * handler (see apps/api/src/ops/index.ts). An entry is either a plain
 * result object `{ rows: [...] }` or a `throw` marker `{ __throw: Error }`
 * — the marker makes that one query reject so the safe* wrappers can be
 * exercised against a simulated statement_timeout / connection failure.
 */
type ResultOrThrow = { rows: unknown[] } | { __throw: Error };

let executeResults: ResultOrThrow[] = [];

mock.module('../shared/db', () => ({
  db: {
    execute: async () => {
      const next = executeResults.shift();
      if (next && '__throw' in next) throw next.__throw;
      return next ?? { rows: [] };
    },
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
  config: { KORTIX_BILLING_INTERNAL_ENABLED: false, INTERNAL_KORTIX_ENV: 'dev' },
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

/** Build the happy-path queue: all 10 db.execute calls succeed. */
function happyPathResults(): ResultOrThrow[] {
  return [
    { rows: [{ count: 2 }] }, // accounts
    { rows: [{ count: 3 }] }, // projects
    { rows: [{ count: 1 }] }, // active legacy sandboxes
    { rows: [{ key: 'running', count: 4 }, { key: 'failed', count: 1 }] }, // sessions
    { rows: [{ key: 'active', count: 3 }, { key: 'error', count: 1 }] }, // sandboxes by status
    { rows: [{ key: 'daytona', count: 2 }, { key: 'platinum', count: 2 }] }, // sandboxes by provider
    { rows: [{ count: 9 }] }, // audit_events_24h
    { rows: [{ key: 'applied', count: 1 }] }, // legacy sandbox migrations
    {
      rows: [
        {
          provider: 'openrouter',
          calls: 7,
          input_tokens: 100,
          output_tokens: 50,
          cached_tokens: 10,
          cost_usd: '0.123456',
        },
      ],
    }, // usage 24h
    {
      rows: [
        {
          event_id: '00000000-0000-4000-a000-000000000901',
          account_id: '00000000-0000-4000-a000-000000000101',
          actor_user_id: '00000000-0000-4000-a000-000000000001',
          action: 'POST /v1/projects',
          resource_type: 'project',
          resource_id: '00000000-0000-4000-a000-000000000201',
          occurred_at: new Date('2026-05-15T00:00:00Z'),
        },
      ],
    }, // recent audit events
  ];
}

describe('ops overview dashboard API', () => {
  beforeEach(() => {
    process.env.BETTERSTACK_API_LOG_TOKEN = 'log-token-test';
    process.env.BETTERSTACK_API_LOG_HOST = 'logs.example.test';
    process.env.BETTERSTACK_API_SENTRY_DSN = 'https://example@sentry.test/1';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://otel.example.test/v1/traces';
    executeResults = happyPathResults();
  });

  test('returns production support signals for API, queues, audit, usage, and migrations', async () => {
    const res = await app().request('/v1/ops/overview');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.api).toEqual({
      status: 'ok',
      env: 'dev',
      billing_enabled: false,
      tunnel: { enabled: true, connectedAgents: 2 },
    });
    expect(body.totals).toMatchObject({
      accounts: 2,
      projects: 3,
      active_legacy_sandboxes: 1,
    });
    expect(body.sessions.by_status).toMatchObject({ running: 4, failed: 1 });
    expect(body.sandboxes.by_provider).toMatchObject({ daytona: 2, platinum: 2 });
    expect(body.queues.queued_total).toBe(0);
    expect(body.queues.trigger_events_by_status).toEqual({});
    expect(body.queues.channel_events_by_status).toEqual({});
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

  test('degrades audit_events_24h to null (not a 500) when its count query times out', async () => {
    // Regression for Better Stack error
    // 4ba74f8c17f3e48e13c07511fb802ec55ba07294237c0985f3df792729e8f4d8 —
    // the audit_events 24h count hit statement_timeout (unindexed full scan)
    // and, inside Promise.all, took the whole /ops/overview down with it.
    // Index 6 in the queue is the audit_events_24h count (see happyPathResults).
    const queue = happyPathResults();
    queue[6] = { __throw: new Error('Failed query: SELECT count(*)::int AS count FROM kortix.audit_events WHERE occurred_at >= now() - interval \'24 hours\'') };
    executeResults = queue;

    const res = await app().request('/v1/ops/overview');
    // The dashboard MUST still 200 — only the failing metric degrades.
    expect(res.status).toBe(200);
    const body = await res.json();

    // The failing metric is null, not undefined, not 0, not an error.
    expect(body.audit.events_24h).toBeNull();
    // Every OTHER metric still populated correctly — the rest of the
    // dashboard is unaffected by the one timed-out query.
    expect(body.totals).toMatchObject({ accounts: 2, projects: 3, active_legacy_sandboxes: 1 });
    expect(body.sessions.by_status).toMatchObject({ running: 4, failed: 1 });
    expect(body.sandboxes.by_provider).toMatchObject({ daytona: 2, platinum: 2 });
    expect(body.audit.recent[0]).toMatchObject({ action: 'POST /v1/projects' });
    expect(body.usage).toMatchObject({ calls_24h: 7, cost_usd_24h: 0.123456 });
    expect(body.migrations.by_status).toMatchObject({ applied: 1 });
  });

  test('degrades usage aggregation to null when the usage 24h query fails', async () => {
    // Index 8 in the queue is usageLast24h.
    const queue = happyPathResults();
    queue[8] = { __throw: new Error('statement timeout') };
    executeResults = queue;

    const res = await app().request('/v1/ops/overview');
    expect(res.status).toBe(200);
    const body = await res.json();

    // Usage degrades: per-provider list is null, and the derived aggregates
    // (which reduce over the list) are null too — never NaN/throw.
    expect(body.usage.last_24h_by_provider).toBeNull();
    expect(body.usage.calls_24h).toBeNull();
    expect(body.usage.cost_usd_24h).toBeNull();
    // Unrelated metrics survive.
    expect(body.audit.events_24h).toBe(9);
    expect(body.totals.accounts).toBe(2);
  });

  test('degrades recent audit events to null (not 500) when its query fails', async () => {
    // Index 9 in the queue is recentAuditEvents.
    const queue = happyPathResults();
    queue[9] = { __throw: new Error('connection terminated') };
    executeResults = queue;

    const res = await app().request('/v1/ops/overview');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit.recent).toBeNull();
    // The 24h count is unaffected.
    expect(body.audit.events_24h).toBe(9);
  });

  test('degrades a group-count query to {} (empty map) on failure', async () => {
    // Index 3 is sessions by status.
    const queue = happyPathResults();
    queue[3] = { __throw: new Error('Failed query: SELECT status AS key, count(*) ...') };
    executeResults = queue;

    const res = await app().request('/v1/ops/overview');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Empty map, never undefined — the dashboard reads a stable shape.
    expect(body.sessions.by_status).toEqual({});
    expect(body.sessions.errored).toBe(0); // .failed ?? 0 on the empty map
    // Other groups unaffected.
    expect(body.sandboxes.by_provider).toMatchObject({ daytona: 2, platinum: 2 });
  });
});
