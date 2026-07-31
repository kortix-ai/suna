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

class InvalidSessionCostQueryError extends Error {}

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
  InvalidSessionCostQueryError,
  parseSessionCostListQuery: (input: { limit?: string; offset?: string }) => {
    const limit = input.limit === undefined ? 25 : Number(input.limit);
    const offset = input.offset === undefined ? 0 : Number(input.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidSessionCostQueryError('limit must be an integer from 1 to 100');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new InvalidSessionCostQueryError('offset must be a non-negative integer');
    }
    return { limit, offset };
  },
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

const { usageApp } = await import('./usage');

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
    expect(listInput).toEqual({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      limit: 25,
      offset: 0,
    });
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
