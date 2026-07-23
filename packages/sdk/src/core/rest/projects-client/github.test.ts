import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  listGitHubRepositories,
  listGitHubRepositoryBranches,
  saveGitHubInstallation,
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

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });

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
