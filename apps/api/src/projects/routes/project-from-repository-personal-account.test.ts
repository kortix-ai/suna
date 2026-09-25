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
 * The route must refuse before it calls GitHub, with a typed 409 the client can
 * branch on. Organization owners are unchanged.
 *
 * Mocking shape mirrors `./project-from-repository-glyph-wiring.test.ts`: no database, no network.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

function fakeInstallation(ownerLogin: string, ownerType: 'User' | 'Organization') {
  const now = new Date();
  return {
    installationRowId: '00000000-0000-4000-a000-000000009932',
    accountId: FAKE_ACCOUNT_ID,
    installationId: '777001',
    ownerLogin,
    ownerType,
    repositorySelection: 'all',
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

const realGithub = await import('../github');

// The real `createRepo` refuses this case itself (`../github.test.ts` pins
// that). Here the mock reproduces its typed refusal, so this file tests what
// the ROUTE does with it: a 409 carrying the code, and nothing registered.
const mockCreateRepo = mock(async (input: { name: string }) => {
  if (currentOwner.type === 'User') {
    throw new realGithub.GitHubPersonalAccountCreateUnsupportedError(currentOwner.login);
  }
  return fakeRepo(currentOwner.login, input.name);
});
mock.module('../github', () => ({
  ...realGithub,
  createRepo: mockCreateRepo,
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
  mockCreateRepo.mockClear();
  mockRegisterGitHub.mockClear();
});

describe('POST /create-repo — GitHub owner type', () => {
  test('a personal account is refused with a typed 409 and GitHub is never called', async () => {
    currentOwner = { login: 'octo-person', type: 'User' };
    const res = await postCreateRepo();
    const body = (await res.json()) as { code?: string; error?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('github_personal_account_create_unsupported');
    expect(mockCreateRepo).toHaveBeenCalledTimes(1);
    // A sentence a user can act on, never GitHub's raw API text.
    expect(body.error).toContain('octo-person');
    expect(body.error).toMatch(/import/i);
    expect(body.error).not.toContain('/user/repos');
    expect(body.error).not.toContain('Resource not accessible');
    expect(mockRegisterGitHub).not.toHaveBeenCalled();
  });

  test('an organization account still creates the repository', async () => {
    currentOwner = { login: 'acme', type: 'Organization' };
    const res = await postCreateRepo();

    expect(res.status).toBe(201);
    expect(mockCreateRepo).toHaveBeenCalledTimes(1);
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
  });
});
