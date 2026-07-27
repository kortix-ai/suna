import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  createGitHubConnectSession,
  createGitHubReconnectSession,
  disconnectGitHubConnection,
  linkRepository,
  linkGitHubInstallation,
  listLinkableGitHubInstallations,
  listGitHubRepositories,
  listGitHubRepositoryBranches,
  refreshGitHubConnection,
  saveGitHubInstallation,
  type LinkableGitHubInstallationsResponse,
  type GitHubRepositoriesResponse,
  type GitHubRepositoryBranchesResponse,
} from './github';

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return Response.json({
      account_id: 'account 1',
      installation_id: '84',
      owner_login: 'acme',
      repo_full_name: 'acme/portal',
      default_branch: 'trunk',
      branches: [
        { name: 'trunk', protected: true },
        { name: 'release/next', protected: false },
      ],
    } satisfies GitHubRepositoryBranchesResponse);
  }) as unknown as typeof fetch;
});

test('sends the GitHub user proof when saving an installation', async () => {
  let requestBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      account_id: 'account 1',
      installation_row_id: 'row-1',
      installed: true,
      configured: true,
      requires_installation: false,
      install_url: null,
      installation_id: '84',
      owner_login: 'acme',
      owner_type: 'Organization',
      repository_selection: 'all',
      permissions: {},
      installation_url: null,
      updated_at: null,
    });
  }) as unknown as typeof fetch;

  await saveGitHubInstallation({
    state: 'signed-state',
    installation_id: '84',
    github_user_token: 'github-user-token',
  });

  expect(requestBody).toEqual({
    state: 'signed-state',
    installation_id: '84',
    github_user_token: 'github-user-token',
  });
});

test('lists only linkable GitHub App installations through the authenticated API', async () => {
  let requestBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      account_id: 'account 1',
      github_login: 'markokraemer',
      configured: true,
      install_url: 'https://github.com/apps/kortix/installations/new?state=signed',
      installations: [
        {
          installation_id: '84',
          owner_login: 'markokraemer',
          owner_type: 'User',
          repository_selection: 'selected',
          permissions: { contents: 'write' },
          installation_url: 'https://github.com/settings/installations/84',
          linked: false,
        },
      ],
    } satisfies LinkableGitHubInstallationsResponse);
  }) as unknown as typeof fetch;

  const result = await listLinkableGitHubInstallations({
    account_id: 'account 1',
    github_user_token: 'github-user-token',
  });

  expect(requestBody).toEqual({
    account_id: 'account 1',
    github_user_token: 'github-user-token',
  });
  expect(result.github_login).toBe('markokraemer');
  expect(result.installations[0]?.owner_login).toBe('markokraemer');
});

test('links a selected verified GitHub App installation without callback state', async () => {
  let requestBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      account_id: 'account 1',
      installation_row_id: 'row-1',
      installed: true,
      configured: true,
      requires_installation: false,
      install_url: null,
      installation_id: '84',
      owner_login: 'markokraemer',
      owner_type: 'User',
      repository_selection: 'selected',
      permissions: { contents: 'write' },
      installation_url: 'https://github.com/settings/installations/84',
      updated_at: null,
    });
  }) as unknown as typeof fetch;

  await linkGitHubInstallation({
    account_id: 'account 1',
    installation_id: '84',
    github_user_token: 'github-user-token',
  });

  expect(requestBody).toEqual({
    account_id: 'account 1',
    installation_id: '84',
    github_user_token: 'github-user-token',
  });
});

configureKortix({
  backendUrl: 'http://test.local/v1',
  getToken: async () => 'token',
});

test('lists repository branches through the typed account-scoped GitHub surface', async () => {
  const result = await listGitHubRepositoryBranches('account 1', '84', 'acme/portal');

  expect(calls).toEqual([
    'http://test.local/v1/projects/github/repository-branches?' +
      'account_id=account+1&installation_id=84&repo_full_name=acme%2Fportal',
  ]);
  expect(result.default_branch).toBe('trunk');
  expect(result.branches).toEqual([
    { name: 'trunk', protected: true },
    { name: 'release/next', protected: false },
  ]);
});

test('passes bounded repository search options through the typed GitHub surface', async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return Response.json({
      account_id: 'account 1',
      installation_id: 'pat',
      owner_login: 'managed-kortix',
      repositories: [],
    } satisfies GitHubRepositoriesResponse);
  }) as unknown as typeof fetch;

  await listGitHubRepositories('account 1', 'pat', {
    search: 'customer portal',
    limit: 25,
  });

  expect(calls).toEqual([
    'http://test.local/v1/projects/github/repositories?' +
      'account_id=account+1&installation_id=pat&search=customer+portal&limit=25',
  ]);
});

test('sends the selected repository identity when linking a repository', async () => {
  let requestBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      project: {
        project_id: 'project-1',
        account_id: 'account 1',
      },
      git_connection: null,
    });
  }) as unknown as typeof fetch;

  await linkRepository({
    account_id: 'account 1',
    installation_id: '84',
    repository_id: '123456',
    repo_full_name: 'acme/portal',
    default_branch: 'trunk',
  });

  expect(requestBody).toEqual({
    account_id: 'account 1',
    installation_id: '84',
    repository_id: '123456',
    repo_full_name: 'acme/portal',
    default_branch: 'trunk',
  });
});

test('serializes Nango connection lifecycle inputs through stable GitHub routes', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith('/connect-session') || url.endsWith('/reconnect-session')) {
      return Response.json({
        token: 'connect-token',
        expires_at: '2026-07-27T18:00:00.000Z',
        connect_link: 'https://connect.nango.dev/session',
      });
    }
    const installation = {
      account_id: 'account 1',
      installation_row_id: 'row-1',
      installed: true,
      configured: true,
      requires_installation: false,
      install_url: null,
      installation_id: '84',
      owner_login: 'acme',
      owner_type: 'Organization',
      repository_selection: 'all',
      permissions: {},
      installation_url: null,
      updated_at: '2026-07-27T17:00:00.000Z',
      connection_id: 'nango-connection-1',
      connection_provider: 'nango',
      connection_status: 'connected',
      reconnect_required: false,
    };
    return Response.json(
      init?.method === 'DELETE' ? { ok: true, ...installation } : installation,
    );
  }) as unknown as typeof fetch;

  const connect = await createGitHubConnectSession({ accountId: 'account 1' });
  const reconnect = await createGitHubReconnectSession({
    accountId: 'account 1',
    installationId: '84',
  });
  const refreshed = await refreshGitHubConnection({
    accountId: 'account 1',
    installationId: '84',
  });
  const disconnected = await disconnectGitHubConnection({
    accountId: 'account 1',
    installationId: '84',
  });

  expect(connect.token).toBe('connect-token');
  expect(reconnect.connect_link).toBe('https://connect.nango.dev/session');
  expect(refreshed.connection_status).toBe('connected');
  expect(disconnected.ok).toBe(true);
  expect(disconnected.connection_provider).toBe('nango');
  expect(requests).toEqual([
    {
      url: 'http://test.local/v1/projects/github/connect-session',
      method: 'POST',
      body: { account_id: 'account 1' },
    },
    {
      url:
        'http://test.local/v1/projects/github/installations/84/reconnect-session',
      method: 'POST',
      body: { account_id: 'account 1' },
    },
    {
      url: 'http://test.local/v1/projects/github/installations/84/refresh',
      method: 'POST',
      body: { account_id: 'account 1' },
    },
    {
      url:
        'http://test.local/v1/projects/github/installations/84?account_id=account+1',
      method: 'DELETE',
      body: null,
    },
  ]);
});
