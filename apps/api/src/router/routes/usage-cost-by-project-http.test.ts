import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as realAccess from '../../workspaces/lib/access';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000001';
const WORKSPACE_ID = '00000000-0000-4000-a000-000000000002';

let authType = 'supabase';
let sandboxId: string | null = null;
let listInput: Record<string, unknown> | null = null;
let resolveAccountDenied = false;

interface TestContext {
  set(key: string, value: unknown): void;
  req: {
    query(key: string): string | undefined;
  };
}

const project = {
  project_id: WORKSPACE_ID,
  project_name: 'Workspace One',
  session_count: 3,
  llm_cost: 1.5,
  compute_cost: 0.5,
  total_cost: 2,
  last_activity_at: '2026-07-01T12:00:00.000Z',
};

// Mutable so CSV-path tests can swap in a row carrying quoting/injection
// characters without disturbing the JSON-path tests, which rely on the
// static `project` fixture above.
let projectsToReturn: Record<string, unknown>[] = [project];

mock.module('../../middleware/auth', () => ({
  combinedAuth: async (c: TestContext, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-a000-000000000004');
    c.set('authType', authType);
    if (sandboxId) c.set('sandboxId', sandboxId);
    await next();
  },
}));

mock.module('../../shared/resolve-account', () => ({
  resolveScopedAccountId: async (c: TestContext) => {
    if (resolveAccountDenied) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }
    return c.req.query('account_id') || ACCOUNT_ID;
  },
}));

// projects/lib/access.ts is a real module usage.ts also imports (for the
// sibling /session-costs routes' project-scoped fallback). /cost-by-project
// never calls into it, but the static import still has to resolve — the real
// module pulls in resolveAccountId from the mocked resolve-account above,
// which does not export it.
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../workspaces/lib/access', () => ({
  ...realAccess,
  loadWorkspaceForUser: async () => {
    throw new Error('loadWorkspaceForUser should not be called from cost-by-project tests');
  },
  assertWorkspaceCapability: async () => {
    throw new Error('assertWorkspaceCapability should not be called from cost-by-project tests');
  },
}));

mock.module('../../shared/cost-rollups', () => ({
  listCostByWorkspace: async (input: Record<string, unknown>) => {
    listInput = input;
    return {
      projects: projectsToReturn,
      total: projectsToReturn.length,
      limit: input.limit,
      offset: input.offset,
      next_offset: null,
    };
  },
  // getCostSummary is a real export usage.ts also imports (for the sibling
  // /cost-summary route). Never exercised in this file — throwing surfaces a
  // mistake immediately instead of silently returning undefined.
  getCostSummary: async () => {
    throw new Error('getCostSummary should not be called from cost-by-project tests');
  },
}));

// session-costs.ts is a real module usage.ts also imports (for the sibling
// /session-costs routes). It is never exercised in this file, but it pulls in
// projects/lib/access's resolveSessionOwnerIdentities, which is not mocked
// here — mock it out too so that unrelated route's module load never runs.
mock.module('../../shared/session-costs', () => ({
  listSessionCosts: async () => {
    throw new Error('listSessionCosts should not be called from cost-by-project tests');
  },
  getSessionCostRecord: async () => {
    throw new Error('getSessionCostRecord should not be called from cost-by-project tests');
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
  resolveAccountDenied = false;
  projectsToReturn = [project];
});

describe('GET /v1/usage/cost-by-workspace', () => {
  test('is the canonical rollup route and returns Workspace fields', async () => {
    const response = await createTestApp().request(
      `/v1/usage/cost-by-workspace?account_id=${ACCOUNT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({
      accountId: ACCOUNT_ID,
      limit: 25,
      offset: 0,
      sort: 'total_desc',
    });
    expect(await response.json()).toEqual({
      workspaces: [
        {
          workspace_id: WORKSPACE_ID,
          workspace_name: 'Workspace One',
          session_count: 3,
          llm_cost: 1.5,
          compute_cost: 0.5,
          total_cost: 2,
          last_activity_at: '2026-07-01T12:00:00.000Z',
        },
      ],
      total: 1,
      limit: 25,
      offset: 0,
      next_offset: null,
    });
  });

  test('exports canonical Workspace CSV columns', async () => {
    const response = await createTestApp().request('/v1/usage/cost-by-workspace?format=csv');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="kortix-cost-by-workspace.csv"',
    );
    expect((await response.text()).split(/\r?\n/)[0]).toBe(
      'workspace_id,workspace_name,sessions,llm_cost_usd,compute_cost_usd,total_cost_usd,last_activity_at',
    );
  });
});

describe('GET /v1/usage/cost-by-project', () => {
  test('uses pagination defaults and returns the complete rollup envelope', async () => {
    const response = await createTestApp().request(
      `/v1/usage/cost-by-project?account_id=${ACCOUNT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({
      accountId: ACCOUNT_ID,
      limit: 25,
      offset: 0,
      sort: 'total_desc',
    });
    const window = (listInput as { window: { from: Date; to: Date } }).window;
    expect(window.to.getTime() - window.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    // format is absent: the JSON envelope, content-type and headers must be
    // byte-identical to what this route returned before format=csv existed.
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-kortix-row-cap')).toBeNull();
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.json()).toEqual({
      projects: [project],
      total: 1,
      limit: 25,
      offset: 0,
      next_offset: null,
    });
  });

  test('passes explicit pagination to the aggregation service', async () => {
    const response = await createTestApp().request('/v1/usage/cost-by-project?limit=10&offset=20');

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({ limit: 10, offset: 20 });
  });

  test('passes the parsed window and sort through to the service', async () => {
    const response = await createTestApp().request(
      '/v1/usage/cost-by-project?from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z&sort=name_asc',
    );

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({ sort: 'name_asc' });
    const window = (listInput as { window: { from: Date; to: Date } }).window;
    expect(window.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-07-08T00:00:00.000Z');
  });

  test('rejects an inverted window with 400', async () => {
    const response = await createTestApp().request(
      '/v1/usage/cost-by-project?from=2026-08-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z',
    );

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  test('rejects an unsupported sort with 400', async () => {
    const response = await createTestApp().request('/v1/usage/cost-by-project?sort=cheapest');

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  test('rejects invalid pagination before querying costs', async () => {
    const response = await createTestApp().request('/v1/usage/cost-by-project?limit=101');

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  test('preserves the account-wide sandbox-token rejection', async () => {
    authType = 'apiKey';
    sandboxId = '00000000-0000-4000-a000-000000000099';

    const response = await createTestApp().request('/v1/usage/cost-by-project');

    expect(response.status).toBe(403);
    expect(listInput).toBeNull();
  });

  // accountId resolves before window/sort/pagination are parsed (in that
  // order, inside one try block) — same order the route used before
  // format=csv existed. A request that is both unauthorized AND carries a
  // malformed window must still 403, not 400: an unauthorized caller should
  // not learn which of their parameters was invalid before finding out they
  // cannot access the account at all.
  test('resolves account access before validating the window: 403 wins over 400', async () => {
    resolveAccountDenied = true;

    const response = await createTestApp().request(
      '/v1/usage/cost-by-project?from=2026-08-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z',
    );

    expect(response.status).toBe(403);
    expect(listInput).toBeNull();
  });
});

describe('GET /v1/usage/cost-by-project?format=csv', () => {
  test('returns a CSV attachment with content-type, disposition and the row-cap header', async () => {
    const response = await createTestApp().request(
      `/v1/usage/cost-by-project?account_id=${ACCOUNT_ID}&format=csv`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="kortix-cost-by-project.csv"',
    );
    expect(response.headers.get('x-kortix-row-cap')).toBe('10000');
  });

  test('queries CSV_ROW_CAP rows at offset 0, ignoring any limit/offset params', async () => {
    const response = await createTestApp().request(
      '/v1/usage/cost-by-project?format=csv&limit=10&offset=20',
    );

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({ limit: 10_000, offset: 0 });
  });

  test('runs the same filtered query as the JSON path: account, sort and window', async () => {
    const response = await createTestApp().request(
      `/v1/usage/cost-by-project?account_id=${ACCOUNT_ID}&sort=name_asc` +
        '&from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z&format=csv',
    );

    expect(response.status).toBe(200);
    expect(listInput).toMatchObject({ accountId: ACCOUNT_ID, sort: 'name_asc' });
    const window = (listInput as { window: { from: Date; to: Date } }).window;
    expect(window.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-07-08T00:00:00.000Z');
  });

  test('renders a header row and one data row per project', async () => {
    const response = await createTestApp().request(
      `/v1/usage/cost-by-project?account_id=${ACCOUNT_ID}&format=csv`,
    );

    expect(await response.text()).toBe(
      'project_id,project_name,sessions,llm_cost_usd,compute_cost_usd,total_cost_usd,' +
        'last_activity_at\r\n' +
        `${WORKSPACE_ID},Workspace One,3,1.5,0.5,2,2026-07-01T12:00:00.000Z`,
    );
  });

  test('neutralises a formula-prefixed project name', async () => {
    projectsToReturn = [{ ...project, project_name: '=cmd|calc!A0' }];

    const response = await createTestApp().request(
      `/v1/usage/cost-by-project?account_id=${ACCOUNT_ID}&format=csv`,
    );
    const [, dataLine] = (await response.text()).split('\r\n');

    expect(dataLine).toContain('"\'=cmd|calc!A0"');
  });

  test('rejects an invalid window before querying costs, like the JSON path', async () => {
    const response = await createTestApp().request(
      '/v1/usage/cost-by-project?format=csv&from=2026-08-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z',
    );

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  test('rejects invalid pagination before querying costs, like the JSON path', async () => {
    const response = await createTestApp().request('/v1/usage/cost-by-project?format=csv&limit=101');

    expect(response.status).toBe(400);
    expect(listInput).toBeNull();
  });

  test('preserves the account-wide sandbox-token rejection on the CSV path too', async () => {
    authType = 'apiKey';
    sandboxId = '00000000-0000-4000-a000-000000000099';

    const response = await createTestApp().request('/v1/usage/cost-by-project?format=csv');

    expect(response.status).toBe(403);
    expect(listInput).toBeNull();
  });

  test('resolves account access before validating the window on the CSV path too: 403 wins over 400', async () => {
    resolveAccountDenied = true;

    const response = await createTestApp().request(
      '/v1/usage/cost-by-project?format=csv&from=2026-08-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z',
    );

    expect(response.status).toBe(403);
    expect(listInput).toBeNull();
  });
});
