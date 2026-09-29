/**
 * Characterization pins for the gateway routes before and after the split of
 * `routes/gateway.ts` into sibling route modules (KRTX-291): the split must
 * register the same 19 routes and leave the pinned behavior byte-for-byte
 * equal. The pins drive the REGISTERED routes through `projectsApp.request`
 * with the shared db and the project-access helpers mocked, so they need no
 * live database, and they run unchanged against origin/main and against the
 * split.
 *
 * `mock.module` is process-wide, but `scripts/test.sh` runs every unit file
 * with `bun test --isolate`, so these mocks stay file-local.
 *
 * Live-Postgres behavior is NOT pinned here — the db-backed suites
 * (`integration-gateway-keys.test.ts` and the rest of the db-suites lane) own
 * it, and they are named as environment limits in the KRTX-291 PR.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gatewayRequestLogs } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';
// The real module, captured BEFORE the mock replaces it: the mock spreads it
// so every other export the gateway graph imports (session-costs reaches
// resolveSessionOwnerIdentities through here) stays real, and only the three
// names the pinned routes call are stubbed.
import * as realAccess from '../lib/access';

// ─── Mocked collaborators ────────────────────────────────────────────────────

type Capture = {
  fields?: unknown;
  table?: unknown;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
  offset?: number;
  rows: unknown[];
};

let captures: Capture[] = [];
let logRows: unknown[] = [];
let project: { userId: string; row: { accountId: string; metadata: Record<string, unknown> } } | null = {
  userId: 'user-1',
  row: { accountId: 'acct-1', metadata: {} },
};

function builder(state: Capture): unknown {
  return {
    where: (w: unknown) => {
      state.where = w;
      return builder(state);
    },
    orderBy: (...o: unknown[]) => {
      state.orderBy = o;
      return builder(state);
    },
    groupBy: (..._g: unknown[]) => builder(state),
    limit: (n: number) => {
      state.limit = n;
      return builder(state);
    },
    offset: (n: number) => {
      state.offset = n;
      return builder(state);
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(state.rows).then(onFulfilled, onRejected),
  };
}

mock.module('../../shared/db', () => ({
  db: {
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        // Only the pinned routes run here and both read gateway request logs;
        // any other table fails loudly instead of passing silently.
        if (table !== gatewayRequestLogs) {
          throw new Error('unexpected table in gateway-routes.test db mock');
        }
        const state: Capture = { fields, table, rows: logRows };
        captures.push(state);
        return builder(state);
      },
    }),
  },
  hasDatabase: true,
}));

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => project,
  assertProjectCapability: async () => undefined,
  lookupEmailsByUserIds: async () => new Map(),
}));

// Mocks first, then the real modules: the hoisted-import order would win
// otherwise.
const { projectsApp } = await import('../lib/app');
await import('./gateway');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    logId: 'log-1',
    requestId: 'req-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    requestedModel: 'model-a',
    resolvedModel: 'model-b',
    provider: 'prov-1',
    status: 200,
    ok: true,
    errorCode: null,
    errorMessage: null,
    latencyMs: 42,
    attempts: 1,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 3,
    cacheWriteTokens: 4,
    upstreamCost: '0.1000',
    finalCost: '0.5000',
    streaming: false,
    billingMode: 'credits',
    actorUserId: 'user-1',
    keyId: 'key-1',
    ...overrides,
  };
}

async function call(path: string) {
  const res = await projectsApp.request(path);
  return { status: res.status, body: await res.json() };
}

const rendered = (value: unknown) => new PgDialect().sqlToQuery(value as any).sql;

beforeEach(() => {
  captures = [];
  logRows = [];
  project = { userId: 'user-1', row: { accountId: 'acct-1', metadata: {} } };
});

// ─── Registration: the split must keep every route on the same app ──────────

describe('gateway route registration', () => {
  test('all 19 gateway method+path pairs are registered on projectsApp', () => {
    // Hono's table carries one entry per validator/handler layer of an OpenAPI
    // route (each pair below appears 2-3 times), so dedupe to the surface.
    const registered = [
      ...new Set(
        projectsApp.routes
          .filter((r) => r.path.includes('/gateway/') && r.method !== 'ALL')
          .map((r) => `${r.method.toLowerCase()} /${r.path.split('/').slice(2).join('/')}`),
      ),
    ].sort();
    expect(registered).toHaveLength(19);
    expect(registered).toEqual([
      'delete /gateway/budgets/:budgetId',
      'delete /gateway/keys/:keyId',
      'delete /gateway/routing-policy',
      'get /gateway/breakdown',
      'get /gateway/budgets',
      'get /gateway/errors',
      'get /gateway/keys',
      'get /gateway/logs',
      'get /gateway/logs/:logId',
      'get /gateway/overview',
      'get /gateway/routing-policy',
      'get /gateway/series',
      'get /gateway/sessions',
      'post /gateway/keys',
      'post /gateway/playground',
      'post /gateway/providers/:providerId/verify',
      'post /gateway/routing-policy/preview',
      'put /gateway/budgets',
      'put /gateway/routing-policy',
    ]);
  });
});

// ─── GET /gateway/logs — pagination + serialization ─────────────────────────

describe('GET /{projectId}/gateway/logs', () => {
  test('fetches limit+1 rows and pages with next_offset when more exist', async () => {
    logRows = Array.from({ length: 11 }, (_, i) => logRow({ logId: `log-${i + 1}` }));

    const { status, body } = await call('/p1/gateway/logs?limit=10');

    expect(status).toBe(200);
    expect(body.logs).toHaveLength(10); // the +1 probe row is sliced off
    expect(body.logs[0].log_id).toBe('log-1'); // first row wins, order preserved
    expect(body.next_offset).toBe(10); // offset + limit
    expect(captures[0].limit).toBe(11); // THE limit+1 probe
    expect(captures[0].offset).toBe(0);
    expect(captures[0].orderBy).toHaveLength(1); // desc(createdAt)
  });

  test('returns next_offset null on the last page — still probing limit+1', async () => {
    logRows = Array.from({ length: 5 }, (_, i) => logRow({ logId: `log-${i + 1}` }));

    const { body } = await call('/p1/gateway/logs?limit=10');

    expect(body.logs).toHaveLength(5);
    expect(body.next_offset).toBeNull();
    expect(captures[0].limit).toBe(11);
  });

  test('no limit defaults to 50; limit clamps at 100 — both probed with +1', async () => {
    logRows = Array.from({ length: 101 }, (_, i) => logRow({ logId: `log-${i + 1}` }));

    const unbounded = await call('/p1/gateway/logs');
    expect(captures[0].limit).toBe(51); // default 50, probed at 51
    expect(unbounded.body.logs).toHaveLength(50);
    expect(unbounded.body.next_offset).toBe(50);

    const clamped = await call('/p1/gateway/logs?limit=250');
    expect(captures[1].limit).toBe(101); // max 100, probed at 101
    expect(clamped.body.logs).toHaveLength(100);
    expect(clamped.body.next_offset).toBe(100);
  });

  test('a falsy limit falls back to the default 50', async () => {
    logRows = [logRow()];
    await call('/p1/gateway/logs?limit=0');
    expect(captures[0].limit).toBe(51);
  });

  test('ok=true adds the ok condition to the query, absence does not', async () => {
    logRows = [logRow()];
    await call('/p1/gateway/logs?ok=true');
    expect(rendered(captures[0].where)).toContain('"ok"');

    await call('/p1/gateway/logs?limit=1');
    expect(rendered(captures[1].where)).not.toContain('"ok"');
    // The project condition is always present.
    expect(rendered(captures[1].where)).toContain('project_id');
  });

  test('serializes a row to the wire shape, spend split per billing mode', async () => {
    logRows = [logRow()];

    const { body } = await call('/p1/gateway/logs?limit=1');

    // billingMode 'credits': Kortix billed, so provider_cost is 0 (the
    // wholesale upstream price never leaks) and total == kortix_cost.
    expect(body.logs[0]).toEqual({
      log_id: 'log-1',
      request_id: 'req-1',
      created_at: '2026-01-01T00:00:00.000Z', // JSON round-trip: Date → ISO string
      requested_model: 'model-a',
      resolved_model: 'model-b',
      provider: 'prov-1',
      status: 200,
      ok: true,
      error_code: null,
      error_message: null,
      latency_ms: 42,
      attempts: 1,
      input_tokens: 10,
      output_tokens: 20,
      cached_tokens: 3,
      cache_write_tokens: 4,
      kortix_cost: 0.5,
      provider_cost: 0,
      total_cost: 0.5,
      upstream_cost: 0, // deprecated, same value as provider_cost
      final_cost: 0.5, // deprecated, same value as kortix_cost
      streaming: false,
      billing_mode: 'credits',
      actor_user_id: 'user-1',
      key_id: 'key-1',
    });
  });

  test('unknown project → 404 before any query', async () => {
    project = null;

    const { status } = await call('/p1/gateway/logs');

    expect(status).toBe(404);
    expect(captures).toHaveLength(0);
  });
});

// ─── GET /gateway/overview — the spend total ────────────────────────────────

describe('GET /{projectId}/gateway/overview', () => {
  test('maps the aggregate row to the wire shape at the default 30-day window', async () => {
    logRows = [
      {
        requests: 7,
        errors: 2,
        totalCost: 12.5,
        kortixCost: 10,
        providerCost: 2.5,
        inputTokens: '100',
        outputTokens: '200',
      },
    ];

    const { status, body } = await call('/p1/gateway/overview');

    expect(status).toBe(200);
    expect(body).toEqual({
      window_days: 30,
      requests: 7,
      errors: 2,
      total_cost: 12.5,
      kortix_cost: 10,
      provider_cost: 2.5,
      input_tokens: 100, // strings from postgres → numbers on the wire
      output_tokens: 200,
    });
  });

  test('no aggregate row → all zeros, never undefined', async () => {
    logRows = [];

    const { body } = await call('/p1/gateway/overview');

    expect(body).toEqual({
      window_days: 30,
      requests: 0,
      errors: 0,
      total_cost: 0,
      kortix_cost: 0,
      provider_cost: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  test('days clamps into [1, 365], default 30', async () => {
    logRows = [];
    expect((await call('/p1/gateway/overview?days=999')).body.window_days).toBe(365);
    expect((await call('/p1/gateway/overview?days=0')).body.window_days).toBe(30);
    expect((await call('/p1/gateway/overview?days=abc')).body.window_days).toBe(30);
  });

  test('the total is the total-spend money expression, not final_cost alone', async () => {
    logRows = [];
    await call('/p1/gateway/overview');

    const fields = captures[0].fields as Record<string, unknown>;
    expect(rendered(fields.totalCost)).toContain('upstream_cost_precise');
    expect(rendered(fields.totalCost)).toContain('final_cost_precise');
    // Kortix-billed slice: only what the wallet was debited.
    expect(rendered(fields.kortixCost)).toContain('final_cost_precise');
    // Provider-billed slice: the upstream side.
    expect(rendered(fields.providerCost)).toContain('upstream_cost_precise');
  });

  test('unknown project → 404 before any query', async () => {
    project = null;

    const { status } = await call('/p1/gateway/overview');

    expect(status).toBe(404);
    expect(captures).toHaveLength(0);
  });
});
