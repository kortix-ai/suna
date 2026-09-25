/**
 * `POST /create-repo` under a PERSONAL GitHub account.
 *
 * Every GitHub-backed create authenticates with the account's GitHub App
 * installation token. For a `User` owner, `createRepo` has to call
 * `POST /user/repos`, and GitHub does not accept installation tokens on that
 * endpoint (it is absent from GitHub's "Endpoints available for GitHub App
 * installation access tokens"; `POST /orgs/{org}/repos` is present). Prod
 * answered `GitHub /user/repos failed (403): Resource not accessible by
 * integration`, which the route passed through as a 502 with GitHub's raw text.
 *
 * GitHub DOES accept a user access token there, so the route creates with the
 * caller's stored one. Without a usable token it answers a typed 409 that asks
 * for authorization. Organization owners keep the installation token.
 *
 * Mocking shape mirrors `./project-from-repository-glyph-wiring.test.ts`: no database, no network.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { GitHubPersonalAccountCreateUnsupportedError } from '../lib/github-create-errors';

const FAKE_ACCOUNT_ID = '00000000-0000-4000-a000-000000009930';
const FAKE_USER_ID = '00000000-0000-4000-a000-000000009931';

function fakeRepo(owner: string, name: string) {
  return {
    id: Math.floor(Math.random() * 1_000_000_000),
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

let repositorySelection = 'all';

function fakeInstallation(ownerLogin: string, ownerType: 'User' | 'Organization') {
  const now = new Date();
  return {
    installationRowId: '00000000-0000-4000-a000-000000009932',
    accountId: FAKE_ACCOUNT_ID,
    installationId: '777001',
    ownerLogin,
    ownerType,
    repositorySelection,
    permissions: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

let currentOwner: { login: string; type: 'User' | 'Organization' } = {
  login: 'octo-person',
  type: 'User',
};

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  resolveProjectAccount: async () => ({ userId: FAKE_USER_ID, accountId: FAKE_ACCOUNT_ID }),
  enforceProjectQuota: async () => null,
}));

const realIam = await import('../../iam');
mock.module('../../iam', () => ({
  ...realIam,
  assertAuthorized: async () => {},
}));

const realGit = await import('../lib/git');
mock.module('../lib/git', () => ({
  ...realGit,
  resolveGitHubRepoAuth: async () => ({
    auth: {
      token: 'fake-installation-token',
      source: 'app_installation' as const,
      owner: currentOwner.login,
      ownerType: currentOwner.type,
      installationId: '777001',
    },
    authSource: 'app_installation' as const,
    installation: fakeInstallation(currentOwner.login, currentOwner.type),
  }),
  getProjectGitConnection: async () => null,
}));

let storedUserToken: { token: string; githubLogin: string; expiresAt: number | null } | null = null;
const realUserToken = await import('../lib/github-user-token');
mock.module('../lib/github-user-token', () => ({
  ...realUserToken,
  resolveGitHubUserToken: async (input: { ownerLogin: string }) =>
    storedUserToken && storedUserToken.githubLogin.toLowerCase() === input.ownerLogin.toLowerCase()
      ? storedUserToken
      : null,
}));

const realGithub = await import('../github');

// The real `createRepo` refuses an installation token under a personal owner
// (`../github.test.ts` pins that). Here the mock reproduces the refusal so this
// file tests what the ROUTE does: which credential it hands over, and what it
// answers when there is none.
const mockAddRepositoryToInstallation = mock(
  async (_input: { installationId: string; repositoryId: number; auth: { token: string; source?: string } }) => {},
);
const mockCreateRepo = mock(async (input: { name: string; auth?: { source?: string } }) => {
  if (currentOwner.type === 'User' && input.auth?.source !== 'user_token') {
    throw new GitHubPersonalAccountCreateUnsupportedError(currentOwner.login);
  }
  return fakeRepo(currentOwner.login, input.name);
});
mock.module('../github', () => ({
  ...realGithub,
  createRepo: mockCreateRepo,
  addRepositoryToInstallation: mockAddRepositoryToInstallation,
  commitFile: async () => {},
  getFileSha: async () => null,
}));

const realBuilder = await import('../../snapshots/builder');
mock.module('../../snapshots/builder', () => ({
  ...realBuilder,
  kickProjectTemplatePrebuilds: () => {},
}));

const now = new Date();
const mockRegisterGitHub = mock(async () => ({
  projectId: 'proj-personal-account-test',
  accountId: FAKE_ACCOUNT_ID,
  name: 'company',
  repoUrl: `https://github.com/${currentOwner.login}/company.git`,
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: now,
  updatedAt: now,
}));
mock.module('../lib/project-registration', () => ({
  registerGitHubLinkedProject: mockRegisterGitHub,
  registerPatLinkedProject: async () => {
    throw new Error('not used');
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./project-from-repository');

function postCreateRepo() {
  return projectsApp.request('/create-repo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'company', installation_id: '777001' }),
  });
}

beforeEach(() => {
  repositorySelection = 'all';
  mockAddRepositoryToInstallation.mockClear();
  storedUserToken = null;
  mockCreateRepo.mockClear();
  mockRegisterGitHub.mockClear();
});

describe('POST /create-repo — a selected-repositories installation', () => {
  test('the new repository is granted to the installation before the starter lands', async () => {
    currentOwner = { login: 'octo-person', type: 'User' };
    repositorySelection = 'selected';
    storedUserToken = { token: 'ghu_live', githubLogin: 'octo-person', expiresAt: null };

    const res = await postCreateRepo();

    expect(res.status).toBe(201);
    expect(mockAddRepositoryToInstallation).toHaveBeenCalledTimes(1);
    const granted = mockAddRepositoryToInstallation.mock.calls[0]?.[0];
    expect(granted?.installationId).toBe('777001');
    // The user token, not the installation token: only a user may grant.
    expect(granted?.auth?.source).toBe('user_token');
  });

  test('an `all` installation already sees it, so nothing is granted', async () => {
    currentOwner = { login: 'octo-person', type: 'User' };
    storedUserToken = { token: 'ghu_live', githubLogin: 'octo-person', expiresAt: null };

    expect((await postCreateRepo()).status).toBe(201);
    expect(mockAddRepositoryToInstallation).not.toHaveBeenCalled();
  });

  test('a refused grant names the step instead of handing back a project Kortix cannot write to', async () => {
    currentOwner = { login: 'octo-person', type: 'User' };
    repositorySelection = 'selected';
    storedUserToken = { token: 'ghu_live', githubLogin: 'octo-person', expiresAt: null };
    mockAddRepositoryToInstallation.mockImplementationOnce(async () => {
      throw new Error('GitHub /user/installations/777001/repositories/1 failed (404): Not Found');
    });

    const res = await postCreateRepo();
    const body = (await res.json()) as { code?: string; error?: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe('github_installation_repository_grant_failed');
    expect(body.error).toContain('octo-person/company');
    expect(mockRegisterGitHub).not.toHaveBeenCalled();
  });
});

describe('POST /create-repo — GitHub owner type', () => {
  test('a personal account with a stored user token creates with THAT token', async () => {
    currentOwner = { login: 'octo-person', type: 'User' };
    storedUserToken = { token: 'ghu_live', githubLogin: 'octo-person', expiresAt: null };

    const res = await postCreateRepo();

    expect(res.status).toBe(201);
    const handed = mockCreateRepo.mock.calls[0]?.[0] as { auth?: { source?: string; token?: string } };
    expect(handed.auth?.source).toBe('user_token');
    expect(handed.auth?.token).toBe('ghu_live');
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
  });

  test("a token for another login is not this owner's token", async () => {
    currentOwner = { login: 'octo-person', type: 'User' };
    storedUserToken = { token: 'ghu_other', githubLogin: 'someone-else', expiresAt: null };

    const res = await postCreateRepo();
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('github_user_authorization_required');
    expect(mockCreateRepo).not.toHaveBeenCalled();
  });

  test('a personal account with no user token asks for authorization, and GitHub is never called', async () => {
    currentOwner = { login: 'octo-person', type: 'User' };

    const res = await postCreateRepo();
    const body = (await res.json()) as { code?: string; error?: string; owner_login?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('github_user_authorization_required');
    expect(body.owner_login).toBe('octo-person');
    // A sentence a user can act on, never GitHub's raw API text.
    expect(body.error).toContain('octo-person');
    expect(body.error).not.toContain('/user/repos');
    expect(body.error).not.toContain('Resource not accessible');
    expect(mockCreateRepo).not.toHaveBeenCalled();
    expect(mockRegisterGitHub).not.toHaveBeenCalled();
  });

  test('the refusal never carries a token', async () => {
    currentOwner = { login: 'octo-person', type: 'User' };
    storedUserToken = { token: 'ghu_secret', githubLogin: 'someone-else', expiresAt: null };

    const raw = await (await postCreateRepo()).text();

    expect(raw).not.toContain('ghu_secret');
  });

  test('an organization account still creates the repository', async () => {
    currentOwner = { login: 'acme', type: 'Organization' };
    const res = await postCreateRepo();

    expect(res.status).toBe(201);
    expect(mockCreateRepo).toHaveBeenCalledTimes(1);
    const handed = mockCreateRepo.mock.calls[0]?.[0] as { auth?: { source?: string } };
    expect(handed.auth?.source).toBe('app_installation');
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
  });
});
