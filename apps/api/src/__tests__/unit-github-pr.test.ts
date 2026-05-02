import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Stub config so env validation doesn't fail
mock.module('../config', () => ({
  config: {
    GITHUB_TOKEN: 'ghp_test_token_123',
    ENV_MODE: 'local',
    INTERNAL_KORTIX_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    KORTIX_URL: 'http://localhost:3000',
  },
}));

// ─── Mock GitHub API responses ────────────────────────────────────────────────

const MOCK_PR = {
  html_url: 'https://github.com/kortix-ai/suna/pull/42',
  number: 42,
  head: { sha: 'abc123def456' },
};

const MOCK_CHECK_RUNS_PASS = {
  check_runs: [
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'success' },
  ],
};

const MOCK_CHECK_RUNS_FAIL = {
  check_runs: [{ status: 'completed', conclusion: 'failure' }],
};

const MOCK_CHECK_RUNS_PENDING = {
  check_runs: [{ status: 'in_progress', conclusion: null }],
};

type FetchBehavior = 'pass' | 'fail' | 'pending' | 'none' | 'error422';

function makeFetch(checkBehavior: FetchBehavior = 'pass'): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (url.includes('/pulls') && (init?.method === 'POST' || !init?.method)) {
      if (checkBehavior === 'error422') {
        return new Response(JSON.stringify({ message: 'A pull request already exists for this branch.' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(MOCK_PR), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/check-runs')) {
      const data =
        checkBehavior === 'fail' ? MOCK_CHECK_RUNS_FAIL :
        checkBehavior === 'pending' ? MOCK_CHECK_RUNS_PENDING :
        checkBehavior === 'none' ? { check_runs: [] } :
        MOCK_CHECK_RUNS_PASS;
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /v1/github/pull-request', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns pr_url, pr_number, ci_status:pass on success', async () => {
    globalThis.fetch = makeFetch('pass') as unknown as typeof fetch;

    const cb = `?t=${Date.now()}`;
    const { githubApp } = await import(`../routes/github.ts${cb}`);

    const res = await githubApp.request('http://localhost/pull-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: 'kortix-ai/suna',
        branch: 'kortix/agent-abc123',
        base: 'main',
        title: 'fix: improve auth',
        body: 'Opened by Kortix agent',
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as { pr_url: string; pr_number: number; ci_status: string };
    expect(json.pr_url).toBe('https://github.com/kortix-ai/suna/pull/42');
    expect(json.pr_number).toBe(42);
    expect(json.ci_status).toBe('pass');
  });

  test('ci_status:fail when any check run failed', async () => {
    globalThis.fetch = makeFetch('fail') as unknown as typeof fetch;

    const cb = `?t=${Date.now() + 1}`;
    const { githubApp } = await import(`../routes/github.ts${cb}`);

    const res = await githubApp.request('http://localhost/pull-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'kortix-ai/suna', branch: 'feat/x', base: 'main', title: 'x' }),
    });

    const json = await res.json() as { ci_status: string };
    expect(res.status).toBe(201);
    expect(json.ci_status).toBe('fail');
  });

  test('ci_status:pending when checks in progress', async () => {
    globalThis.fetch = makeFetch('pending') as unknown as typeof fetch;

    const cb = `?t=${Date.now() + 2}`;
    const { githubApp } = await import(`../routes/github.ts${cb}`);

    const res = await githubApp.request('http://localhost/pull-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'kortix-ai/suna', branch: 'feat/y', base: 'main', title: 'y' }),
    });

    const json = await res.json() as { ci_status: string };
    expect(json.ci_status).toBe('pending');
  });

  test('returns 400 when repo missing', async () => {
    const cb = `?t=${Date.now() + 3}`;
    const { githubApp } = await import(`../routes/github.ts${cb}`);

    const res = await githubApp.request('http://localhost/pull-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feat/z', base: 'main' }),
    });

    expect(res.status).toBe(400);
  });

  test('returns 422 on GitHub validation error (e.g. PR already exists)', async () => {
    globalThis.fetch = makeFetch('error422') as unknown as typeof fetch;

    const cb = `?t=${Date.now() + 4}`;
    const { githubApp } = await import(`../routes/github.ts${cb}`);

    const res = await githubApp.request('http://localhost/pull-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'kortix-ai/suna', branch: 'feat/already', base: 'main', title: 'dup' }),
    });

    expect(res.status).toBe(422);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('already exists');
  });
});
