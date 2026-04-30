import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../config', () => ({
  config: {
    ENV_MODE: 'local',
    INTERNAL_KORTIX_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    KORTIX_URL: 'http://localhost:3000',
    GITHUB_TOKEN: '',
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => 'acc-test-123',
}));

let execCalls: string[] = [];
let mockExecCode = 0;
let mockExecStdout = '';

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [{ externalId: 'sb-ext-1', baseUrl: 'http://sandbox:8000' }],
          }),
        }),
      }),
    }),
  },
  eq: () => ({}),
  desc: () => ({}),
}));

mock.module('@kortix/db', () => ({
  sandboxes: {
    externalId: { name: 'external_id' },
    baseUrl: { name: 'base_url' },
    accountId: { name: 'account_id' },
    updatedAt: { name: 'updated_at' },
  },
}));

function makeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/kortix/core/exec') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(String(init?.body)) as { cmd: string };
      execCalls.push(body.cmd);

      // Simulate different commands
      if (body.cmd.includes('test -d')) {
        return new Response(JSON.stringify({ code: 1, stdout: 'missing', stderr: '' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.cmd.includes('git clone')) {
        return new Response(JSON.stringify({ code: mockExecCode, stdout: mockExecCode === 0 ? '' : mockExecStdout, stderr: mockExecStdout }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.cmd.includes('head -c 2000')) {
        return new Response(JSON.stringify({ code: 0, stdout: '# README\n\nThis is a test repo.', stderr: '' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.cmd.includes('symbolic-ref')) {
        return new Response(JSON.stringify({ code: 0, stdout: 'main', stderr: '' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 0, stdout: '', stderr: '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe('POST /v1/github/clone', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
    execCalls = [];
    mockExecCode = 0;
    mockExecStdout = '';
  });

  test('returns 400 for missing repo_url', async () => {
    const cb = `?t=${Date.now()}`;
    const { githubCloneApp } = await import(`../routes/github-clone.ts${cb}`);
    const res = await githubCloneApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid GitHub URL', async () => {
    const cb = `?t=${Date.now() + 1}`;
    const { githubCloneApp } = await import(`../routes/github-clone.ts${cb}`);
    const res = await githubCloneApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: 'https://gitlab.com/owner/repo' }),
    });
    expect(res.status).toBe(400);
  });

  test('successful clone returns correct shape', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    const cb = `?t=${Date.now() + 2}`;
    const { githubCloneApp } = await import(`../routes/github-clone.ts${cb}`);
    const res = await githubCloneApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: 'https://github.com/kortix-ai/suna' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as {
      cloned_path: string; repo_name: string; readme_summary: string; default_branch: string;
    };
    expect(json.cloned_path).toBe('/workspace/suna');
    expect(json.repo_name).toBe('kortix-ai/suna');
    expect(json.readme_summary).toContain('README');
    expect(json.default_branch).toBe('main');
  });

  test('returns 422 on clone failure', async () => {
    mockExecCode = 128;
    mockExecStdout = 'Repository not found';
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    const cb = `?t=${Date.now() + 3}`;
    const { githubCloneApp } = await import(`../routes/github-clone.ts${cb}`);
    const res = await githubCloneApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: 'https://github.com/private/repo' }),
    });
    expect(res.status).toBe(422);
    const json = await res.json() as { error: string; detail: string };
    expect(json.error).toBe('clone_failed');
    expect(json.detail).toContain('Repository not found');
  });

  test('token is masked in error output', async () => {
    mockExecCode = 128;
    mockExecStdout = 'fatal: secret-token-here@github.com not found';
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    const cb = `?t=${Date.now() + 4}`;
    const { githubCloneApp } = await import(`../routes/github-clone.ts${cb}`);
    const res = await githubCloneApp.request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: 'https://github.com/owner/repo', github_access_token: 'secret-token-here' }),
    });
    const json = await res.json() as { detail: string };
    expect(json.detail).not.toContain('secret-token-here');
    expect(json.detail).toContain('***');
  });
});
