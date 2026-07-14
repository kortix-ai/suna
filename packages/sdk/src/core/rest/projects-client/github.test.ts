import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  listGitHubRepositoryBranches,
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
