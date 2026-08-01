import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000001';
const PROJECT_ID = '00000000-0000-4000-a000-000000000002';
const SECONDARY_ACCOUNT_ID = '00000000-0000-4000-a000-000000000003';
const USER_ID = '00000000-0000-4000-a000-000000000004';
const SESSION_ID = 'session-cost-test';

let authType = 'supabase';
let sandboxId: string | null = null;
let listInput: Record<string, unknown> | null = null;
let detailInput: Record<string, unknown> | null = null;
let detailFound = true;
let projectAccessInput: { projectId: string; action: string } | null = null;
let projectCapabilityInput: {
  userId: string;
  accountId: string;
  projectId: string;
  action: string;
} | null = null;
let projectCapabilityDenied = false;

interface TestContext {
  set(key: string, value: unknown): void;
  req: {
    query(key: string): string | undefined;
  };
}

const summary = {
  session_id: SESSION_ID,
  project_id: PROJECT_ID,
  project_name: 'Project One',
  owner_id: null,
  owner_type: null,
  owner_name: null,
  owner_email: null,
  status: 'stopped',
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T11:00:00.000Z',
  last_activity_at: null,
  llm_cost: 0,
  compute_cost: 0,
  total_cost: 0,
  request_count: 0,
  error_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
  model_count: 0,
  compute_seconds: 0,
};

const reconciliation = {
  llm_cost: 0,
  compute_cost: 0,
  total_cost: 0,
  request_count: 0,
  compute_window_count: 0,
  compute_seconds: 0,
};

mock.module('../../middleware/auth', () => ({
  combinedAuth: async (c: TestContext, next: () => Promise<void>) => {
    c.set('userId', USER_ID);
    c.set('authType', authType);
    if (sandboxId) c.set('sandboxId', sandboxId);
    await next();
  },
}));

mock.module('../../shared/resolve-account', () => ({
  resolveScopedAccountId: async (c: TestContext) => c.req.query('account_id') || ACCOUNT_ID,
}));

mock.module('../../projects/lib/access', () => ({
  loadProjectForUser: async (_c: TestContext, projectId: string, action: string) => {
    projectAccessInput = { projectId, action };
    return { userId: USER_ID, row: { accountId: SECONDARY_ACCOUNT_ID } };
  },
  assertProjectCapability: async (
    _c: TestContext,
    userId: string,
    accountId: string,
    projectId: string,
    action: string,
  ) => {
    projectCapabilityInput = { userId, accountId, projectId, action };
    if (projectCapabilityDenied) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }
  },
}));

mock.module('../../shared/session-costs', () => ({
  listSessionCosts: async (input: Record<string, unknown>) => {
    listInput = input;
    return {
      sessions: [summary],
      total: 1,
      limit: input.limit,
      offset: input.offset,
      next_offset: null,
      reconciliation,
    };
  },
  getSessionCostRecord: async (input: Record<string, unknown>) => {
    detailInput = input;
    if (!detailFound) return null;
    return { ...summary, model_usage: [], ledger_entries: [] };
  },
}));

const { usageApp, SESSION_COST_SORTS } = await import('./usage');

function createTestApp() {
  const app = new Hono();
  app.route('/v1/usage', usageApp);
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  });
  return app;
}

beforeEach(() => {
  authType = 'supabase';
  sandboxId = null;
  listInput = null;
  detailInput = null;
  detailFound = true;
  projectAccessInput = null;
  projectCapabilityInput = null;
  projectCapabilityDenied = false;
});

describe('GET /v1/usage/session-costs', () => {
  test('uses pagination defaults and returns the complete list envelope', async () => {
    const response = await createTestApp().request(
      `/v1/usage/session-costs?account_id=${ACCOUNT_ID}&project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      limit: 25,
      offset: 0,
      sort: 'total_desc',
    });
    const window = (listInput as { window: { from: Date; to: Date } }).window;
    expect(window.to.getTime() - window.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(await response.json()).toEqual({
      sessions: [summary],
      total: 1,
      limit: 25,
      offset: 0,
      next_offset: null,
      reconciliation,
    });
  });

  test('passes explicit pagination to the aggregation service', async () => {
    const response = await createTestApp().request('/v1/usage/session-costs?limit=10&offset=20');

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({ limit: 10, offset: 20 });
  });

  test('passes the parsed window and sort through to the service', async () => {
    const response = await createTestApp().request(
      '/v1/usage/session-costs?from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z&sort=recent',
    );

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({ sort: 'recent' });
    const window = (listInput as { window: { from: Date; to: Date } }).window;
    expect(window.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-07-08T00:00:00.000Z');
  });

  test('defaults to spend-descending over the trailing 30 days', async () => {
    const response = await createTestApp().request('/v1/usage/session-costs');

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({ sort: 'total_desc' });
    const window = (listInput as { window: { from: Date; to: Date } }).window;
    expect(window.to.getTime() - window.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('rejects an inverted window with 400', async () => {
    const response = await createTestApp().request(
      '/v1/usage/session-costs?from=2026-08-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z',
    );

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  test('rejects an unsupported sort with 400', async () => {
    const response = await createTestApp().request('/v1/usage/session-costs?sort=cheapest');

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  // CostSort is shared with the project rollup, which has a name_asc sessions
  // cannot honor (sessionCostSortKey throws for it). The route must reject it
  // as a clean 400 through validation, never let it reach the service and 500.
  test('rejects name_asc, which sessions cannot honor, with 400 not 500', async () => {
    const response = await createTestApp().request('/v1/usage/session-costs?sort=name_asc');

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  test('forwards owner_id as a filter', async () => {
    const response = await createTestApp().request(`/v1/usage/session-costs?owner_id=${USER_ID}`);

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({ ownerId: USER_ID });
  });

  test('infers the account from an accessible project when account_id is omitted', async () => {
    const response = await createTestApp().request(
      `/v1/usage/session-costs?project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(projectAccessInput).toEqual({ projectId: PROJECT_ID, action: 'read' });
    expect(projectCapabilityInput).toEqual({
      userId: USER_ID,
      accountId: SECONDARY_ACCOUNT_ID,
      projectId: PROJECT_ID,
      action: 'project.gateway.spend.read',
    });
    expect(listInput).toMatchObject({
      accountId: SECONDARY_ACCOUNT_ID,
      projectId: PROJECT_ID,
    });
  });

  test('denies project-scoped costs without the spend capability', async () => {
    projectCapabilityDenied = true;

    const response = await createTestApp().request(
      `/v1/usage/session-costs?project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(403);
    expect(projectCapabilityInput).toEqual({
      userId: USER_ID,
      accountId: SECONDARY_ACCOUNT_ID,
      projectId: PROJECT_ID,
      action: 'project.gateway.spend.read',
    });
    expect(listInput).toBeNull();
  });

  test('rejects invalid pagination before querying costs', async () => {
    const response = await createTestApp().request('/v1/usage/session-costs?limit=101');

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  test('preserves the account-wide sandbox-token rejection', async () => {
    authType = 'apiKey';
    sandboxId = '00000000-0000-4000-a000-000000000099';

    const response = await createTestApp().request('/v1/usage/session-costs');

    expect(response.status).toBe(403);
    expect(listInput).toBeNull();
  });
});

// Guards the allowed-sort list directly: the OpenAPI query schema also
// restricts `sort` to these three values, so an HTTP request carrying
// `sort=name_asc` is already rejected before this list is ever consulted.
// Without this assertion, widening the list back to include `name_asc` would
// pass every other test in this file — it is the only test that catches it.
describe('SESSION_COST_SORTS', () => {
  test('excludes name_asc, which sessionCostSortKey cannot honor', () => {
    expect(SESSION_COST_SORTS).toEqual(['total_desc', 'total_asc', 'recent']);
  });
});

describe('GET /v1/usage/session-costs/{sessionId}', () => {
  test('passes account and project scope to the detail service', async () => {
    const response = await createTestApp().request(
      `/v1/usage/session-costs/${SESSION_ID}?account_id=${ACCOUNT_ID}&project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(detailInput).toEqual({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
    expect(await response.json()).toMatchObject({
      session_id: SESSION_ID,
      model_usage: [],
      ledger_entries: [],
    });
  });

  test('returns 404 when the session is outside the resolved scope', async () => {
    detailFound = false;

    const response = await createTestApp().request(
      `/v1/usage/session-costs/${SESSION_ID}?project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(404);
  });

  test('lets session-bound clients address a secondary account through project scope', async () => {
    const response = await createTestApp().request(
      `/v1/usage/session-costs/${SESSION_ID}?project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(projectAccessInput).toEqual({ projectId: PROJECT_ID, action: 'read' });
    expect(projectCapabilityInput).toEqual({
      userId: USER_ID,
      accountId: SECONDARY_ACCOUNT_ID,
      projectId: PROJECT_ID,
      action: 'project.gateway.spend.read',
    });
    expect(detailInput).toMatchObject({
      accountId: SECONDARY_ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
  });

  test('denies project-scoped detail without the spend capability', async () => {
    projectCapabilityDenied = true;

    const response = await createTestApp().request(
      `/v1/usage/session-costs/${SESSION_ID}?project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(403);
    expect(detailInput).toBeNull();
  });
});
