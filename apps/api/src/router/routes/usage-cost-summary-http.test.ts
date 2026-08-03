import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000001';
const PROJECT_ID = '00000000-0000-4000-a000-000000000002';
const SECONDARY_ACCOUNT_ID = '00000000-0000-4000-a000-000000000003';
const USER_ID = '00000000-0000-4000-a000-000000000004';
const SESSION_ID = 'session-cost-summary-test';

let authType = 'supabase';
let sandboxId: string | null = null;
let summaryInput: Record<string, unknown> | null = null;
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
  totals: {
    llm_cost: 12.4,
    compute_cost: 34.02,
    total_cost: 46.42,
    request_count: 100,
    compute_seconds: 3600,
    session_count: 41,
    project_count: 3,
  },
  previous: { total_cost: 37.74 },
  series: [],
  models: [],
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

// listCostByProject is mocked alongside getCostSummary purely because both
// live in the same module usage.ts imports from — this file never exercises
// the /cost-by-project route.
mock.module('../../shared/cost-rollups', () => ({
  getCostSummary: async (input: Record<string, unknown>) => {
    summaryInput = input;
    return summary;
  },
  listCostByProject: async () => ({
    projects: [],
    total: 0,
    limit: 25,
    offset: 0,
    next_offset: null,
  }),
}));

// session-costs.ts is a real module usage.ts also imports (for the sibling
// session-costs routes). It is never exercised in this file, but it pulls in
// projects/lib/access's resolveSessionOwnerIdentities, which the mock above
// does not provide — mock it out too so that unrelated route's module load
// never runs.
mock.module('../../shared/session-costs', () => ({
  listSessionCosts: async () => {
    throw new Error('listSessionCosts should not be called from cost-summary tests');
  },
  getSessionCostRecord: async () => {
    throw new Error('getSessionCostRecord should not be called from cost-summary tests');
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
  summaryInput = null;
  projectAccessInput = null;
  projectCapabilityInput = null;
  projectCapabilityDenied = false;
});

describe('GET /v1/usage/cost-summary', () => {
  test('scopes to the account by default and returns the summary envelope', async () => {
    const response = await createTestApp().request(
      `/v1/usage/cost-summary?account_id=${ACCOUNT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(summaryInput?.accountId).toBe(ACCOUNT_ID);
    expect(summaryInput?.projectId).toBeUndefined();
    expect(summaryInput?.sessionId).toBeUndefined();
    expect(await response.json()).toEqual(summary);
  });

  test('defaults the window to the trailing 30 days when from/to are absent', async () => {
    const response = await createTestApp().request('/v1/usage/cost-summary');

    expect(response.status).toBe(200);
    const window = (summaryInput as { window: { from: Date; to: Date } }).window;
    expect(window.to.getTime() - window.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('passes the parsed window through to the service', async () => {
    const response = await createTestApp().request(
      '/v1/usage/cost-summary?from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z',
    );

    expect(response.status).toBe(200);
    const window = (summaryInput as { window: { from: Date; to: Date } }).window;
    expect(window.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-07-08T00:00:00.000Z');
  });

  test('forwards session_id scope alongside the resolved account', async () => {
    const response = await createTestApp().request(
      `/v1/usage/cost-summary?account_id=${ACCOUNT_ID}&session_id=${SESSION_ID}`,
    );

    expect(response.status).toBe(200);
    expect(summaryInput?.accountId).toBe(ACCOUNT_ID);
    expect(summaryInput?.sessionId).toBe(SESSION_ID);
    expect(summaryInput?.projectId).toBeUndefined();
  });

  test('rejects an inverted window with 400', async () => {
    const response = await createTestApp().request(
      '/v1/usage/cost-summary?from=2026-08-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z',
    );

    expect(response.status).toBe(400);
    expect(summaryInput).toBeNull();
  });

  test('infers the account from an accessible project when account_id is omitted', async () => {
    const response = await createTestApp().request(
      `/v1/usage/cost-summary?project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(projectAccessInput).toEqual({ projectId: PROJECT_ID, action: 'read' });
    expect(projectCapabilityInput).toEqual({
      userId: USER_ID,
      accountId: SECONDARY_ACCOUNT_ID,
      projectId: PROJECT_ID,
      action: 'project.gateway.spend.read',
    });
    expect(summaryInput?.accountId).toBe(SECONDARY_ACCOUNT_ID);
    expect(summaryInput?.projectId).toBe(PROJECT_ID);
  });

  test('denies project-scoped summaries without the spend capability', async () => {
    projectCapabilityDenied = true;

    const response = await createTestApp().request(
      `/v1/usage/cost-summary?project_id=${PROJECT_ID}`,
    );

    expect(response.status).toBe(403);
    expect(projectCapabilityInput).toEqual({
      userId: USER_ID,
      accountId: SECONDARY_ACCOUNT_ID,
      projectId: PROJECT_ID,
      action: 'project.gateway.spend.read',
    });
    expect(summaryInput).toBeNull();
  });

  test('preserves the account-wide sandbox-token rejection', async () => {
    authType = 'apiKey';
    sandboxId = '00000000-0000-4000-a000-000000000099';

    const response = await createTestApp().request('/v1/usage/cost-summary');

    expect(response.status).toBe(403);
    expect(summaryInput).toBeNull();
  });
});
