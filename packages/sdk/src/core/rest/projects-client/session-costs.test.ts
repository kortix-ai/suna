import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  costExportUrl,
  fetchCostExportCsv,
  getCostSummary,
  getSessionCostRecord,
  listCostByProject,
  listSessionCosts,
  type CostSummary,
  type ProjectCostPage,
  type SessionCostDetail,
  type SessionCostsPage,
} from './session-costs';

let calls: { url: string; method: string }[] = [];
let nextResponse: unknown = {};

beforeEach(() => {
  calls = [];
  nextResponse = {};
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return new Response(JSON.stringify(nextResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

const page = {
  sessions: [
    {
      session_id: 'session-1',
      project_id: 'project-1',
      project_name: 'Project One',
      owner_id: 'owner-1',
      owner_type: 'user',
      owner_name: 'Owner One',
      owner_email: 'owner@example.test',
      status: 'running',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
      last_activity_at: '2026-07-02T00:00:00.000Z',
      llm_cost: 1.25,
      compute_cost: 0.5,
      total_cost: 1.75,
      request_count: 2,
      error_count: 0,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 10,
      cache_write_tokens: 5,
      model_count: 1,
      compute_seconds: 120,
    },
  ],
  total: 1,
  limit: 25,
  offset: 0,
  next_offset: null,
  reconciliation: {
    llm_cost: 0.25,
    compute_cost: 0,
    total_cost: 0.25,
    request_count: 1,
    compute_window_count: 0,
    compute_seconds: 0,
  },
} satisfies SessionCostsPage;

const detail = {
  ...page.sessions[0],
  model_usage: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet',
      request_count: 2,
      error_count: 0,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 10,
      cache_write_tokens: 5,
      cost: 1.25,
      last_at: '2026-07-02T00:00:00.000Z',
    },
  ],
  ledger_entries: [
    {
      kind: 'llm',
      id: 'log-1',
      occurred_at: '2026-07-02T00:00:00.000Z',
      cost: 1.25,
      provider: 'anthropic',
      model: 'claude-sonnet',
      request_id: 'request-1',
      status: 200,
      ok: true,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 10,
      cache_write_tokens: 5,
    },
    {
      kind: 'compute',
      id: 'compute-1',
      started_at: '2026-07-01T00:00:00.000Z',
      ended_at: '2026-07-01T00:02:00.000Z',
      billed_through_at: '2026-07-01T00:02:00.000Z',
      cost: 0.5,
      provider: 'daytona',
      state: 'finalized',
      compute_seconds: 120,
      cpu_cores: 2,
      memory_gb: 4,
      disk_gb: 10,
      gpu_count: 0,
    },
  ],
} satisfies SessionCostDetail;

test('listSessionCosts serializes account, project, limit, and zero offset', async () => {
  nextResponse = page;

  const result = await listSessionCosts({
    accountId: 'account-1',
    projectId: 'project-1',
    limit: 25,
    offset: 0,
  });

  expect(last()).toEqual({
    url: 'http://test.local/usage/session-costs?account_id=account-1&project_id=project-1&limit=25&offset=0',
    method: 'GET',
  });
  expect(result).toEqual(page);
});

test('listSessionCosts omits the query string when no filters are supplied', async () => {
  nextResponse = { ...page, sessions: [] };

  await listSessionCosts();

  expect(last().url).toBe('http://test.local/usage/session-costs');
});

test('getSessionCostRecord encodes the session id and serializes scope filters', async () => {
  nextResponse = detail;

  const result = await getSessionCostRecord('session/with space', {
    accountId: 'account-1',
    projectId: 'project-1',
  });

  expect(last()).toEqual({
    url: 'http://test.local/usage/session-costs/session%2Fwith%20space?account_id=account-1&project_id=project-1',
    method: 'GET',
  });
  expect(result.ledger_entries.map((entry) => entry.kind)).toEqual(['llm', 'compute']);
});

// ── listSessionCosts: window, sort, owner extension (Task 8) ──────────────

test('listSessionCosts forwards window, sort and owner as query params', async () => {
  nextResponse = page;

  await listSessionCosts({
    accountId: 'acct-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-08-01T00:00:00.000Z',
    sort: 'total_desc',
    ownerId: 'user-9',
  });

  expect(last()).toEqual({
    url:
      'http://test.local/usage/session-costs?account_id=acct-1&owner_id=user-9' +
      '&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z&sort=total_desc',
    method: 'GET',
  });
});

test('listSessionCosts omits from/to/sort/ownerId when absent, even with other filters set', async () => {
  nextResponse = page;

  await listSessionCosts({ accountId: 'acct-1' });

  const url = last().url;
  expect(url).toBe('http://test.local/usage/session-costs?account_id=acct-1');
  expect(url).not.toContain('from=');
  expect(url).not.toContain('to=');
  expect(url).not.toContain('sort=');
  expect(url).not.toContain('owner_id=');
});

// ── listCostByProject ───────────────────────────────────────────────────

const projectCostPage = {
  projects: [
    {
      project_id: 'project-1',
      project_name: 'Project One',
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
} satisfies ProjectCostPage;

test('listCostByProject targets the rollup route with account, window, sort and paging', async () => {
  nextResponse = projectCostPage;

  const result = await listCostByProject({
    accountId: 'acct-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-08-01T00:00:00.000Z',
    sort: 'total_desc',
    limit: 10,
    offset: 20,
  });

  expect(last()).toEqual({
    url:
      'http://test.local/usage/cost-by-project?account_id=acct-1' +
      '&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z' +
      '&sort=total_desc&limit=10&offset=20',
    method: 'GET',
  });
  expect(result).toEqual(projectCostPage);
});

test('listCostByProject omits the query string when no options are supplied', async () => {
  nextResponse = projectCostPage;

  await listCostByProject();

  expect(last().url).toBe('http://test.local/usage/cost-by-project');
});

test('listCostByProject accepts the project-only name_asc sort', async () => {
  nextResponse = projectCostPage;

  await listCostByProject({ sort: 'name_asc' });

  expect(last().url).toBe('http://test.local/usage/cost-by-project?sort=name_asc');
});

// ── getCostSummary ──────────────────────────────────────────────────────

const costSummary = {
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
  series: [{ day: '2026-07-01', llm_cost: 1, compute_cost: 0.5, total_cost: 1.5 }],
  models: [{ provider: 'anthropic', model: 'claude-sonnet', cost: 12.4, request_count: 100 }],
} satisfies CostSummary;

test('getCostSummary forwards account, project, session scope and window', async () => {
  nextResponse = costSummary;

  const result = await getCostSummary({
    accountId: 'acct-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-08-01T00:00:00.000Z',
  });

  expect(last()).toEqual({
    url:
      'http://test.local/usage/cost-summary?account_id=acct-1&project_id=proj-1' +
      '&session_id=sess-1&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z',
    method: 'GET',
  });
  expect(result).toEqual(costSummary);
});

test('getCostSummary omits the query string when no options are supplied', async () => {
  nextResponse = costSummary;

  await getCostSummary();

  expect(last().url).toBe('http://test.local/usage/cost-summary');
});

// ── costExportUrl ───────────────────────────────────────────────────────
// Pure URL builder — never calls fetch, so it does not touch `calls`.

test('costExportUrl builds the projects CSV export URL with format=csv', () => {
  const url = costExportUrl('projects', {
    accountId: 'acct-1',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-08-01T00:00:00.000Z',
    sort: 'total_desc',
  });

  expect(url).toBe(
    'http://test.local/usage/cost-by-project?account_id=acct-1' +
      '&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z' +
      '&sort=total_desc&format=csv',
  );
});

test('costExportUrl builds the sessions CSV export URL with project and owner scope', () => {
  const url = costExportUrl('sessions', {
    accountId: 'acct-1',
    projectId: 'proj-1',
    ownerId: 'user-9',
    sort: 'recent',
  });

  expect(url).toBe(
    'http://test.local/usage/session-costs?account_id=acct-1&project_id=proj-1' +
      '&owner_id=user-9&sort=recent&format=csv',
  );
});

test('costExportUrl emits only format=csv when no options are supplied', () => {
  expect(costExportUrl('sessions')).toBe('http://test.local/usage/session-costs?format=csv');
  expect(costExportUrl('projects')).toBe('http://test.local/usage/cost-by-project?format=csv');
});

// `project_id`/`owner_id` have no meaning on `/cost-by-project` (it has no
// per-session filter), and `name_asc` has no meaning on `/session-costs` (a
// session has no project name to sort on, mirroring SESSION_COST_SORTS on the
// API). The discriminated overload on `costExportUrl`/`fetchCostExportCsv`
// turns each of these from a runtime-ignored/400-rejected value into a
// compile error — checked here by `tsc --noEmit`, not by `bun test` (bun
// strips types and does not evaluate `@ts-expect-error`). An UNUSED
// `@ts-expect-error` is itself a typecheck error, so this only stays green if
// every line below still fails to compile.
test('costExportUrl and fetchCostExportCsv reject the wrong kind\'s fields at compile time', () => {
  // @ts-expect-error project_id has no meaning on the /cost-by-project route
  costExportUrl('projects', { projectId: 'proj-1' });
  // @ts-expect-error owner_id has no meaning on the /cost-by-project route
  costExportUrl('projects', { ownerId: 'user-9' });
  // @ts-expect-error name_asc is valid only for the project rollup, not sessions
  costExportUrl('sessions', { sort: 'name_asc' });
  // @ts-expect-error project_id has no meaning on the /cost-by-project route
  void fetchCostExportCsv('projects', { projectId: 'proj-1' });
  // @ts-expect-error name_asc is valid only for the project rollup, not sessions
  void fetchCostExportCsv('sessions', { sort: 'name_asc' });

  expect(true).toBe(true);
});

// ── fetchCostExportCsv ───────────────────────────────────────────────────
// Unlike costExportUrl, this DOES call fetch — it owns the whole
// "authenticate, request, return a downloadable Blob" flow the way
// fetchProjectArchive in ./files.ts does, per the architecture rule that
// hosts never raw-fetch the Kortix API. Each test installs its own
// globalThis.fetch mock (overriding the shared beforeEach one) so the
// Authorization header actually sent can be inspected — the shared `calls`
// array used by the tests above only ever recorded {url, method}.

test('fetchCostExportCsv requests the export URL with a Bearer token and parses the row cap', async () => {
  let capturedUrl = '';
  let capturedHeaders: HeadersInit | undefined;
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    capturedUrl = String(url);
    capturedHeaders = opts.headers;
    return new Response('session_id,total_cost\nsession-1,1.75\n', {
      status: 200,
      headers: { 'content-type': 'text/csv', 'x-kortix-row-cap': '10000' },
    });
  }) as unknown as typeof fetch;

  const result = await fetchCostExportCsv('sessions', { accountId: 'acct-1', sort: 'recent' });

  expect(capturedUrl).toBe(
    'http://test.local/usage/session-costs?account_id=acct-1&sort=recent&format=csv',
  );
  expect(capturedHeaders).toEqual({ Authorization: 'Bearer tok' });
  expect(result.rowCap).toBe(10000);
  expect(await result.blob.text()).toBe('session_id,total_cost\nsession-1,1.75\n');
});

test('fetchCostExportCsv targets the projects rollup route for kind "projects"', async () => {
  let capturedUrl = '';
  globalThis.fetch = mock(async (url: unknown) => {
    capturedUrl = String(url);
    return new Response('project_id,total_cost\n', { status: 200 });
  }) as unknown as typeof fetch;

  await fetchCostExportCsv('projects', { accountId: 'acct-1' });

  expect(capturedUrl).toBe('http://test.local/usage/cost-by-project?account_id=acct-1&format=csv');
});

test('fetchCostExportCsv returns rowCap null when the response carries no row-cap header', async () => {
  globalThis.fetch = mock(
    async () => new Response('project_id,total_cost\n', { status: 200 }),
  ) as unknown as typeof fetch;

  const result = await fetchCostExportCsv('projects');

  expect(result.rowCap).toBeNull();
});

test('fetchCostExportCsv throws with the response body on a non-OK response', async () => {
  globalThis.fetch = mock(
    async () => new Response('Forbidden', { status: 403 }),
  ) as unknown as typeof fetch;

  await expect(fetchCostExportCsv('projects')).rejects.toThrow('Forbidden');
});
