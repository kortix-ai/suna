import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gatewayBudgets, gatewayRequestLogs } from '@kortix/db';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';

/**
 * Characterization pins for the gateway routes, written BEFORE
 * `routes/gateway.ts` was split into sibling route modules (KRTX-291).
 * They pin the wire behavior that must not move:
 *
 *   1. `GET /gateway/logs` pagination — the handler asks the DB for
 *      `limit + 1` rows, slices to `limit`, and reports `next_offset`.
 *   2. the log-row projection (camelCase row → snake_case wire, spend split
 *      from shared/llm-spend.ts, deprecated aliases).
 *   3. one spend total — `GET /gateway/overview` aggregates and maps
 *      `total_cost` / `kortix_cost` / `provider_cost`.
 *   4. route registration — all 19 `/gateway/*` routes stay registered on
 *      `projectsApp` after importing `./gateway` (the side-effect entry).
 *
 * The handlers are `projectsApp.openapi(...)` registrations with no per-route
 * export, so the tests mount the real `projectsApp` and drive it over HTTP
 * with a mocked database — the same pattern
 * `__tests__/unit-project-secret-broker-route.test.ts` documents. A live-DB
 * pin would need Docker; that proof stays in the integration suites.
 */

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';

let logRows: Array<Record<string, unknown>> = [];
let aggRow: Record<string, unknown> | null = null;
let exhaustedBudget = false;
const limitCalls: Array<{ limit: number; offset: number }> = [];

const databaseMock = {
  select: (cols: Record<string, unknown> | undefined) => ({
    from: (table: unknown) => ({
      where: (_w: unknown) => {
        if (table === gatewayBudgets) return Promise.resolve(exhaustedBudget ? [{ scope: 'project', action: 'block', period: 'month', limitUsd: '1' }] : []);
        if (table === gatewayRequestLogs && cols && 'cost' in cols) return Promise.resolve([{ cost: 1 }]);
        // `GET /gateway/overview`'s aggregate select ends at `.where()`.
        if (cols && 'totalCost' in cols) return Promise.resolve(aggRow ? [aggRow] : []);
        return {
          orderBy: (..._o: unknown[]) => ({
            limit: (n: number) => ({
              offset: (o: number) => {
                if (table === gatewayRequestLogs) {
                  limitCalls.push({ limit: n, offset: o });
                  return Promise.resolve(logRows);
                }
                throw new Error('unexpected table');
              },
            }),
          }),
        };
      },
    }),
  }),
};

mock.module('../../shared/db', () => ({
  db: databaseMock,
  hasDatabase: true,
  withDbTransaction: async () => {
    throw new Error('not expected in these pins');
  },
  afterDbCommit: () => {},
}));
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
    userId: USER_ID,
  }),
  assertProjectCapability: async () => {},
}));

const { projectsApp } = await import('../lib/app');
await import('./gateway');

function buildApp() {
  const app = new Hono<{
    Variables: { userId: string; authType: 'pat' | 'supabase' };
  }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

const request = (path: string) =>
  buildApp().request(`/v1/projects/${PROJECT_ID}${path}`);

/** One gateway log row as the table returns it (camelCase columns). */
function logRow(overrides: Record<string, unknown> = {}) {
  return {
    logId: 'log-1',
    requestId: 'req-1',
    createdAt: new Date('2026-09-28T00:00:00Z'),
    requestedModel: 'gpt-5',
    resolvedModel: 'gpt-5',
    provider: 'openrouter',
    status: 200,
    ok: true,
    errorCode: null,
    errorMessage: null,
    latencyMs: 120,
    attempts: 1,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    upstreamCost: 0,
    finalCost: 0,
    streaming: false,
    billingMode: 'none',
    actorUserId: USER_ID,
    keyId: null,
    ...overrides,
  };
}

beforeEach(() => {
  logRows = [];
  aggRow = null;
  exhaustedBudget = false;
  limitCalls.length = 0;
});

test('playground returns a typed 402 before dispatch when the project budget is exhausted', async () => {
  exhaustedBudget = true;
  const res = await buildApp().request(`/v1/projects/${PROJECT_ID}/gateway/playground`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello', models: ['synthetic-model'] }),
  });
  expect(res.status).toBe(402);
  expect(await res.json()).toMatchObject({ code: 'budget_exceeded' });
});

describe('GET /gateway/logs pagination (characterization)', () => {
  test('asks the DB for limit + 1 rows and reports next_offset when a page follows', async () => {
    // Three rows for a limit of 2: the DB returned a full extra page.
    logRows = [logRow(), logRow({ logId: 'log-2' }), logRow({ logId: 'log-3' })];
    const res = await request('/gateway/logs?limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[]; next_offset: number | null };
    expect(body.logs).toHaveLength(2);
    expect(body.next_offset).toBe(2);
    expect(limitCalls).toEqual([{ limit: 3, offset: 0 }]);
  });

  test('reports next_offset null when the DB returned no extra row', async () => {
    logRows = [logRow()];
    const res = await request('/gateway/logs?limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[]; next_offset: number | null };
    expect(body.logs).toHaveLength(1);
    expect(body.next_offset).toBeNull();
    expect(limitCalls).toEqual([{ limit: 3, offset: 0 }]);
  });

  test('defaults to 50 and clamps a larger limit to 100', async () => {
    logRows = [];
    await request('/gateway/logs');
    expect(limitCalls).toEqual([{ limit: 51, offset: 0 }]);

    await request('/gateway/logs?limit=999');
    expect(limitCalls).toEqual([
      { limit: 51, offset: 0 },
      { limit: 101, offset: 0 },
    ]);
  });

  test('respects the offset query', async () => {
    logRows = [];
    await request('/gateway/logs?limit=5&offset=10');
    expect(limitCalls).toEqual([{ limit: 6, offset: 10 }]);
  });
});

describe('the log-row projection (characterization)', () => {
  test('maps a row to snake_case and splits the spend', async () => {
    logRows = [
      logRow({ billingMode: 'credits', upstreamCost: 0.02, finalCost: 5 }),
    ];
    const res = await request('/gateway/logs?limit=10');
    const body = (await res.json()) as { logs: Array<Record<string, unknown>> };
    const row = body.logs[0]!;
    // On a managed (credits) row `provider_cost` is 0 on purpose — the
    // upstream price is Kortix's wholesale cost, not the caller's.
    expect(row.kortix_cost).toBe(5);
    expect(row.provider_cost).toBe(0);
    expect(row.total_cost).toBe(5);
    expect(row.upstream_cost).toBe(0);
    expect(row.final_cost).toBe(5);
    expect(row.request_id).toBe('req-1');
    expect(row.billing_mode).toBe('credits');
    expect(row.actor_user_id).toBe(USER_ID);
  });

  test('maps a BYOK row to provider_cost', async () => {
    logRows = [logRow({ billingMode: 'none', upstreamCost: 0.02, finalCost: 0 })];
    const res = await request('/gateway/logs?limit=10');
    const body = (await res.json()) as { logs: Array<Record<string, unknown>> };
    const row = body.logs[0]!;
    expect(row.kortix_cost).toBe(0);
    expect(row.provider_cost).toBe(0.02);
    expect(row.total_cost).toBe(0.02);
  });
});

describe('GET /gateway/overview (characterization)', () => {
  test('returns one spend total for the window', async () => {
    aggRow = {
      requests: 7,
      errors: 1,
      totalCost: 12.5,
      kortixCost: 10,
      providerCost: 2.5,
      inputTokens: '100',
      outputTokens: '50',
    };
    const res = await request('/gateway/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.window_days).toBe(30);
    expect(body.requests).toBe(7);
    expect(body.errors).toBe(1);
    expect(body.total_cost).toBe(12.5);
    expect(body.kortix_cost).toBe(10);
    expect(body.provider_cost).toBe(2.5);
    expect(body.input_tokens).toBe(100);
    expect(body.output_tokens).toBe(50);
  });
});

describe('route registration (characterization)', () => {
  const GATEWAY_ROUTES: Array<[string, string]> = [
    ['get', '/:projectId/gateway/logs'],
    ['get', '/:projectId/gateway/logs/:logId'],
    ['get', '/:projectId/gateway/overview'],
    ['get', '/:projectId/gateway/series'],
    ['get', '/:projectId/gateway/sessions'],
    ['get', '/:projectId/gateway/breakdown'],
    ['get', '/:projectId/gateway/budgets'],
    ['put', '/:projectId/gateway/budgets'],
    ['delete', '/:projectId/gateway/budgets/:budgetId'],
    ['get', '/:projectId/gateway/errors'],
    ['get', '/:projectId/gateway/keys'],
    ['post', '/:projectId/gateway/keys'],
    ['delete', '/:projectId/gateway/keys/:keyId'],
    ['post', '/:projectId/gateway/playground'],
    ['post', '/:projectId/gateway/providers/:providerId/verify'],
    ['get', '/:projectId/gateway/routing-policy'],
    ['put', '/:projectId/gateway/routing-policy'],
    ['delete', '/:projectId/gateway/routing-policy'],
    ['post', '/:projectId/gateway/routing-policy/preview'],
  ];

  test('importing ./gateway registers all 19 gateway routes on projectsApp', () => {
    const registered = new Set(
      (projectsApp.routes as Array<{ method: string; path: string }>)
        .filter((r) => r.path.includes('/gateway/'))
        .map((r) => `${r.method.toLowerCase()} ${r.path}`),
    );
    for (const [method, path] of GATEWAY_ROUTES) {
      expect(registered.has(`${method} ${path}`)).toBe(true);
    }
    // Nothing extra: exactly the 19 pinned registrations, no ghost route.
    expect(registered.size).toBe(GATEWAY_ROUTES.length);
  });
});
