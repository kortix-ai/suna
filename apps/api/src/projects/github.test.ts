import { afterEach, describe, expect, test } from 'bun:test';

import { GitHubApiError, getRepositoryBranch, listRepositoryBranches } from './github';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GitHub repository branches', () => {
  test('lists every page and preserves branch protection metadata', async () => {
    const requests: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      name: `branch-${index}`,
      protected: index === 0,
    }));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const body = url.includes('page=2')
        ? [{ name: 'release/next', protected: true }]
        : firstPage;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const branches = await listRepositoryBranches({
      owner: 'Kortix AI',
      repo: 'suna/web',
      auth: { token: 'test-token' },
    });

    expect(branches).toHaveLength(101);
    expect(branches[0]).toEqual({ name: 'branch-0', protected: true });
    expect(branches[100]).toEqual({ name: 'release/next', protected: true });
    expect(requests).toEqual([
      'https://api.github.com/repos/Kortix%20AI/suna%2Fweb/branches?per_page=100&page=1',
      'https://api.github.com/repos/Kortix%20AI/suna%2Fweb/branches?per_page=100&page=2',
    ]);
  });

  test('looks up a selected branch without confusing slashes for path segments', async () => {
    let requested = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input instanceof Request ? input.url : input);
      return Response.json({ name: 'release/next', protected: false });
    }) as typeof fetch;

    const branch = await getRepositoryBranch({
      owner: 'kortix',
      repo: 'suna',
      branch: 'release/next',
      auth: { token: 'test-token' },
    });

    expect(branch).toEqual({ name: 'release/next', protected: false });
    expect(requested).toBe(
      'https://api.github.com/repos/kortix/suna/branches/release%2Fnext',
    );
  });

  test('preserves the GitHub status at the API boundary', async () => {
    globalThis.fetch = (async () =>
      Response.json({ message: 'Service unavailable' }, { status: 503 })) as unknown as typeof fetch;

    const request = getRepositoryBranch({
      owner: 'kortix',
      repo: 'suna',
      branch: 'dev',
      auth: { token: 'test-token' },
    });

    await expect(request).rejects.toBeInstanceOf(GitHubApiError);
    await expect(request).rejects.toMatchObject({ status: 503 });
  });
});
