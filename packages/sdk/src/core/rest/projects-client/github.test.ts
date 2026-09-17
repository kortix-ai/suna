import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type GitHubRepositoriesResponse,
  type GitHubRepositoryBranchesResponse,
  type LinkableGitHubInstallationsResponse,
  linkGitHubInstallation,
  linkRepository,
  listGitHubRepositories,
  listGitHubRepositoryBranches,
  listLinkableGitHubInstallations,
  saveGitHubInstallation,
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

test('sends the icon in the request body when linking a repository', async () => {
  let requestBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      project: { project_id: 'proj-1', name: 'Iconic', icon: '🚀' },
      git_connection: null,
    });
  }) as unknown as typeof fetch;

  await linkRepository({
    account_id: 'acc-1',
    repo_url: 'https://github.com/acme/repo',
    icon: '🚀',
  });

  expect(requestBody).toEqual({
    account_id: 'acc-1',
    repo_url: 'https://github.com/acme/repo',
    icon: '🚀',
  });
});

test('sends the icon_glyph in the request body when linking a repository', async () => {
  let requestBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      project: {
        project_id: 'proj-1',
        name: 'Glyphic',
        icon_glyph: { name: 'Rocket', color: 'blue' },
      },
      git_connection: null,
    });
  }) as unknown as typeof fetch;

  await linkRepository({
    account_id: 'acc-1',
    repo_url: 'https://github.com/acme/repo',
    icon_glyph: { name: 'Rocket', color: 'blue' },
  });

  expect(requestBody).toEqual({
    account_id: 'acc-1',
    repo_url: 'https://github.com/acme/repo',
    icon_glyph: { name: 'Rocket', color: 'blue' },
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
          linked_to_other_accounts: 2,
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
  // How many OTHER accounts already hold this installation — a count only, so a
  // tenant name can never leak through the picker.
  expect(result.installations[0]?.linked_to_other_accounts).toBe(2);
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
      installation_id: '84',
      owner_login: 'acme',
      repositories: [],
    } satisfies GitHubRepositoriesResponse);
  }) as unknown as typeof fetch;

  await listGitHubRepositories('account 1', '84', {
    search: 'customer portal',
    limit: 25,
  });

  expect(calls).toEqual([
    'http://test.local/v1/projects/github/repositories?' +
      'account_id=account+1&installation_id=84&search=customer+portal&limit=25',
  ]);
});

test('imports through the instance git backend with source: managed, never a fake installation id', async () => {
  let requestBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      project: { project_id: 'project 1' },
      git_connection: null,
    });
  }) as unknown as typeof fetch;

  await linkRepository({
    account_id: 'acc-1',
    repo_full_name: 'managed-kortix/customer-portal',
    source: 'managed',
  });

  // The instance backend used to be selected with `installation_id: 'pat'`,
  // a string dressed as a GitHub installation id. The selector is explicit
  // now and the body carries no installation id at all.
  expect(requestBody).toEqual({
    account_id: 'acc-1',
    repo_full_name: 'managed-kortix/customer-portal',
    source: 'managed',
  });
});
