import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gatewayRequestLogs } from '@kortix/db';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';

// Characterization pins for the gateway routes, written against the module
// layout BEFORE the route split (see KRTX-291). They mount the real route
// module behind a mocked `db` so they run hermetically (no PostgreSQL) and
// keep passing unchanged across the split: `./gateway` stays the side-effect
// entry that registers every route on `projectsApp`, before and after.

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';

type LogRow = Record<string, unknown>;

let dbMode: 'logs' | 'overview' = 'logs';
let logRows: LogRow[] = [];
let overviewAgg: LogRow = {};
let fetchedLimit = 0;
let fetchedOffset = 0;
let openedLimit = 0;
const capabilities: string[] = [];

const databaseMock = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== gatewayRequestLogs) throw new Error('unexpected table');
      if (dbMode === 'overview') return { where: async () => [overviewAgg] };
      return {
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => {
              openedLimit = n;
              return {
                offset: async (o: number) => {
                  fetchedLimit = n;
                  fetchedOffset = o;
                  return logRows;
                },
              };
            },
          }),
        }),
      };
    },
  }),
};

mock.module('../../shared/db', () => ({ db: databaseMock, hasDatabase: true }));
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
    userId: USER_ID,
  }),
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    _accountId: string,
    _projectId: string,
    action: string,
  ) => {
    capabilities.push(action);
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./gateway');

function request(path: string) {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  return app.request(path);
}

function row(overrides: LogRow = {}): LogRow {
  return {
    logId: 'log-1',
    requestId: 'req_gateway_1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    requestedModel: 'requested-model',
    resolvedModel: 'resolved-model',
    provider: 'openai',
    status: 200,
    ok: true,
    latencyMs: 42,
    attempts: 1,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 5,
    cacheWriteTokens: 0,
    streaming: false,
    billingMode: 'none',
    upstreamCost: '1.25',
    finalCost: '0',
    actorUserId: USER_ID,
    keyId: null,
    ...overrides,
  };
}

beforeEach(() => {
  dbMode = 'logs';
  logRows = [];
  overviewAgg = {};
  fetchedLimit = 0;
  fetchedOffset = 0;
  openedLimit = 0;
  capabilities.length = 0;
});

describe('GET /:projectId/gateway/logs (characterization)', () => {
  test('fetches limit+1 rows and paginates with next_offset when a page remains', async () => {
    // Three rows come back for a 2-row page: the +1 probe row stays in the DB
    // result, is sliced off the response, and becomes `next_offset`.
    logRows = [row({ logId: 'log-1' }), row({ logId: 'log-2' }), row({ logId: 'log-3' })];

    const res = await request(`/v1/projects/${PROJECT_ID}/gateway/logs?limit=2&offset=10`);

    expect(res.status).toBe(200);
    // The +1 fetch is the pagination probe: it requests 3 rows to learn a page
    // remains, serves only the first 2, and reports the offset that follows.
    expect(openedLimit).toBe(3);
    expect(fetchedOffset).toBe(10);
    expect(capabilities).toEqual(['project.gateway.logs.read']);
    const body = await res.json();
    expect(body.logs.map((l: { log_id: string }) => l.log_id)).toEqual(['log-1', 'log-2']);
    expect(body.next_offset).toBe(12);
  });

  test('reports next_offset null on the last page and does not over-fetch past the end', async () => {
    logRows = [row({ logId: 'log-9' })];

    const res = await request(`/v1/projects/${PROJECT_ID}/gateway/logs?limit=50&offset=0`);

    expect(res.status).toBe(200);
    expect(openedLimit).toBe(51);
    expect(fetchedOffset).toBe(0);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
    expect(body.next_offset).toBeNull();
  });

  test('defaults the limit to 50 and clamps an oversized one to 100', async () => {
    await request(`/v1/projects/${PROJECT_ID}/gateway/logs`);
    expect(openedLimit).toBe(51);

    await request(`/v1/projects/${PROJECT_ID}/gateway/logs?limit=999`);
    expect(openedLimit).toBe(101);
  });

  test('serializes the spend split of a BYOK row onto the wire', async () => {
    logRows = [
      // BYOK (`none`): the upstream price is what the caller paid; the wallet
      // was never debited, so `upstream_cost` stays the deprecated alias.
      row(),
      // Managed (`credits`): the wallet debit is the spend and the wholesale
      // upstream price is NOT published on the wire.
      row({ logId: 'log-2', billingMode: 'credits', upstreamCost: '0.5', finalCost: '2' }),
    ];

    const res = await request(`/v1/projects/${PROJECT_ID}/gateway/logs`);

    const [byok, credits] = (await res.json()).logs;
    expect(byok).toMatchObject({
      log_id: 'log-1',
      provider_cost: 1.25,
      kortix_cost: 0,
      total_cost: 1.25,
      upstream_cost: 1.25,
      final_cost: 0,
      input_tokens: 10,
      output_tokens: 20,
    });
    expect(credits).toMatchObject({
      kortix_cost: 2,
      provider_cost: 0,
      total_cost: 2,
      upstream_cost: 0,
      final_cost: 2,
    });
  });
});

describe('GET /:projectId/gateway/overview (characterization)', () => {
  test('projects the windowed spend aggregate onto the wire', async () => {
    dbMode = 'overview';
    overviewAgg = {
      requests: 4,
      errors: 1,
      totalCost: 12.5,
      kortixCost: 10,
      providerCost: 2.5,
      inputTokens: '100',
      outputTokens: '50',
    };

    const res = await request(`/v1/projects/${PROJECT_ID}/gateway/overview?days=7`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      window_days: 7,
      requests: 4,
      errors: 1,
      total_cost: 12.5,
      kortix_cost: 10,
      provider_cost: 2.5,
      input_tokens: 100,
      output_tokens: 50,
    });
  });
});
