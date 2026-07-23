import { afterEach, describe, expect, test } from 'bun:test';

import {
  GitHubApiError,
  getRepositoryBranch,
  listOwnerRepositories,
  listRepositoryBranches,
} from './github';

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

function repo(owner: string, name: string) {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    name,
    full_name: `${owner}/${name}`,
    private: true,
    html_url: `https://github.com/${owner}/${name}`,
    clone_url: `https://github.com/${owner}/${name}.git`,
    ssh_url: `git@github.com:${owner}/${name}.git`,
    default_branch: 'main',
    description: null,
  };
}

describe('listOwnerRepositories — the managed-git PAT backend\'s repo lister', () => {
  test('an org owner returns one bounded page ordered by recent activity', async () => {
    const requests: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, i) => repo('acme-corp', `repo-${i}`));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      return new Response(JSON.stringify(url.includes('page=2') ? [] : firstPage), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const repos = await listOwnerRepositories({
      owner: 'acme-corp',
      ownerType: 'Organization',
      auth: { token: 'pat-token' },
    });

    expect(repos).toHaveLength(100);
    expect(requests).toEqual([
      'https://api.github.com/orgs/acme-corp/repos?' +
        'type=all&sort=updated&direction=desc&per_page=100&page=1',
    ]);
    expect(requests.some((u) => u.includes('/user/repos'))).toBe(false);
  });

  test('searches the full org repository set through GitHub search', async () => {
    let requested = '';
    const match = repo('acme-corp', 'customer-portal');
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input instanceof Request ? input.url : input);
      return Response.json({ total_count: 1, incomplete_results: false, items: [match] });
    }) as typeof fetch;

    const repos = await listOwnerRepositories({
      owner: 'acme-corp',
      ownerType: 'Organization',
      auth: { token: 'pat-token' },
      search: 'customer portal',
      limit: 25,
    });

    expect(repos).toEqual([match]);
    expect(requested).toBe(
      'https://api.github.com/search/repositories?' +
        'q=org%3Aacme-corp+customer+portal+in%3Aname%2Cdescription&sort=updated&order=desc&per_page=25&page=1',
    );
  });

  test('a personal (User) owner lists via GET /user/repos, filtered back down to that owner', async () => {
    let requested = '';
    const ownRepo = repo('agent-kortix', 'demo');
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input instanceof Request ? input.url : input);
      // A classic PAT's /user/repos can include repos under OTHER owners
      // (collaborator access) — these must never leak into "repos for the
      // configured owner".
      return Response.json([ownRepo, repo('some-other-org', 'other-repo')]);
    }) as typeof fetch;

    const repos = await listOwnerRepositories({
      owner: 'agent-kortix',
      ownerType: 'User',
      auth: { token: 'pat-token' },
    });

    expect(repos).toEqual([ownRepo]);
    expect(requested).toBe(
      'https://api.github.com/user/repos?' +
        'affiliation=owner%2Ccollaborator&sort=updated&direction=desc&per_page=100&page=1',
    );
  });

  test('no ownerType provided -> falls back to a live account-type lookup', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      if (url.match(/\/users\/[^/]+$/)) return Response.json({ type: 'User' });
      return Response.json([repo('agent-kortix', 'demo')]);
    }) as typeof fetch;

    const repos = await listOwnerRepositories({
      owner: 'agent-kortix',
      auth: { token: 'pat-token' },
    });

    expect(repos.map((r) => r.full_name)).toEqual(['agent-kortix/demo']);
    expect(requests[0]).toBe('https://api.github.com/users/agent-kortix');
  });
});
