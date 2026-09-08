/**
 * Round-1 fix (Task 3 review): the DB-level integration test
 * (`../lib/project-registration.icon.integration.test.ts`) proves Task 2's
 * `projectMetadata` contract on `registerLinkedProject`, but it hand-copies
 * `r2.ts`'s `const icon = normalizeProjectIcon(body.icon)` / `...(icon ? {
 * projectMetadata: { icon } } : {})` instead of calling the real route — so it
 * would not catch a wrong body key (e.g. `body.Icon`) or the spread being
 * deleted from a call site in a later edit.
 *
 * THIS file drives the real `r2.ts` Hono handlers (`projectsApp.request(...)`)
 * for all three call sites — `/link-repository` PAT path,
 * `/link-repository` GitHub-App path, `/create-repo` — and asserts on what
 * they actually pass to `registerGitHubLinkedProject` /
 * `registerPatLinkedProject`, which are mocked here so the test needs no
 * database and no GitHub network access.
 *
 * `mock.module` is process-global in bun:test — same caveat as
 * `../lib/triggers-fire-durable.test.ts`'s neighbors — so this MUST run in its own file (as `--isolate` already does
 * per test file; see `scripts/test.sh`), never folded into another suite.
 * Runs ungated (no TEST_DATABASE_URL) — mocking the registration layer means
 * there is no database to gate against.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const FAKE_ACCOUNT_ID = '00000000-0000-4000-a000-000000009910';
const FAKE_USER_ID = '00000000-0000-4000-a000-000000009911';

function fakeRepo(name: string) {
  return {
    id: Math.floor(Math.random() * 1_000_000_000),
    name,
    full_name: `acme/${name}`,
    private: true,
    html_url: `https://github.com/acme/${name}`,
    clone_url: `https://github.com/acme/${name}.git`,
    ssh_url: `git@github.com:acme/${name}.git`,
    default_branch: 'main',
    description: null,
  };
}

const fakeInstallation = {
  installationRowId: '00000000-0000-4000-a000-000000009912',
  accountId: FAKE_ACCOUNT_ID,
  installationId: '123456',
  ownerLogin: 'acme',
  ownerType: 'Organization',
  repositorySelection: 'selected',
  permissions: {},
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeAuth = {
  token: 'fake-installation-token',
  source: 'app_installation' as const,
  owner: 'acme',
  ownerType: 'Organization' as const,
  installationId: '123456',
};

function fakeProjectRow(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    projectId: `proj-${Math.random().toString(36).slice(2)}`,
    accountId: FAKE_ACCOUNT_ID,
    name: 'icon-wiring-test',
    repoUrl: 'https://github.com/acme/icon-wiring-test.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: {},
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

// ── Auth/quota/access — no DB. `resolveProjectAccount` bypasses the real
// membership lookup entirely; `enforceProjectQuota` always allows.
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

// ── GitHub import/auth resolution — no network. Only the three functions
// r2.ts's target routes call are overridden; everything else stays real.
const realGit = await import('../lib/git');
mock.module('../lib/git', () => ({
  ...realGit,
  resolveGitHubImportWithPat: async () => ({
    repo: fakeRepo('icon-pat-ok'),
    defaultBranch: 'main',
  }),
  resolveGitHubImport: async () => ({
    repo: fakeRepo('icon-gh-ok'),
    installation: fakeInstallation,
    auth: fakeAuth,
    defaultBranch: 'main',
  }),
  resolveGitHubRepoAuth: async () => ({
    auth: fakeAuth,
    authSource: 'app_installation' as const,
    installation: fakeInstallation,
  }),
  getProjectGitConnection: async () => null,
}));

// ── Raw GitHub REST calls (create-repo's repo-create + starter-file commits)
// — no network.
const realGithub = await import('../github');
mock.module('../github', () => ({
  ...realGithub,
  createRepo: async (input: { name: string }) => fakeRepo(input.name),
  commitFile: async () => {},
  getFileSha: async () => null,
}));

// ── Background prebuild kick — fire-and-forget in the real route; stub it so
// no work keeps running after the test (and after the response) returns.
const realBuilder = await import('../../snapshots/builder');
mock.module('../../snapshots/builder', () => ({
  ...realBuilder,
  kickProjectTemplatePrebuilds: () => {},
}));

// ── The subject of this test: r2.ts's three call sites into these two
// functions. Mocked (not spread) so every call is captured.
const mockRegisterGitHub = mock(async (input: Record<string, unknown>) =>
  fakeProjectRow({ metadata: (input.projectMetadata as Record<string, unknown>) ?? {} }),
);
const mockRegisterPat = mock(async (input: Record<string, unknown>) =>
  fakeProjectRow({ metadata: (input.projectMetadata as Record<string, unknown>) ?? {} }),
);
mock.module('../lib/project-registration', () => ({
  registerGitHubLinkedProject: mockRegisterGitHub,
  registerPatLinkedProject: mockRegisterPat,
}));

// Registers r2.ts's routes onto the shared `projectsApp` singleton. r1.ts
// (which attaches the `supabaseAuth` middleware) is deliberately NOT
// imported, so these requests need no Authorization header — auth itself is
// mocked out above via `assertAuthorized`.
const { projectsApp } = await import('../lib/app');
await import('./r2');

function post(path: string, body: Record<string, unknown>) {
  return projectsApp.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockRegisterGitHub.mockClear();
  mockRegisterPat.mockClear();
});

describe('r2.ts icon wiring — POST /link-repository (PAT path)', () => {
  test('a valid icon is threaded into registerPatLinkedProject as projectMetadata.icon', async () => {
    const res = await post('/link-repository', {
      repo_url: 'https://github.com/acme/icon-pat-ok.git',
      github_token: 'fake-user-pat',
      name: 'icon-pat-ok',
      icon: '🚀',
    });

    expect(res.status).toBe(201);
    expect(mockRegisterPat).toHaveBeenCalledTimes(1);
    expect(mockRegisterPat).toHaveBeenCalledWith(
      expect.objectContaining({ projectMetadata: { icon: '🚀' } }),
    );
    expect(mockRegisterGitHub).not.toHaveBeenCalled();
  });

  test('a malformed icon reaches registerPatLinkedProject with NO projectMetadata key at all', async () => {
    const res = await post('/link-repository', {
      repo_url: 'https://github.com/acme/icon-pat-bad.git',
      github_token: 'fake-user-pat',
      name: 'icon-pat-bad',
      icon: 'x'.repeat(5000),
    });

    expect(res.status).toBe(201);
    expect(mockRegisterPat).toHaveBeenCalledTimes(1);
    const call = mockRegisterPat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('projectMetadata' in call).toBe(false);
  });
});

describe('r2.ts icon wiring — POST /link-repository (GitHub App path)', () => {
  test('a valid icon is threaded into registerGitHubLinkedProject as projectMetadata.icon', async () => {
    const res = await post('/link-repository', {
      repo_url: 'https://github.com/acme/icon-gh-ok.git',
      name: 'icon-gh-ok',
      icon: '👍🏽',
    });

    expect(res.status).toBe(201);
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
    expect(mockRegisterGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ projectMetadata: { icon: '👍🏽' } }),
    );
    expect(mockRegisterPat).not.toHaveBeenCalled();
  });

  test('no icon in the body reaches registerGitHubLinkedProject with NO projectMetadata key at all', async () => {
    const res = await post('/link-repository', {
      repo_url: 'https://github.com/acme/icon-gh-absent.git',
      name: 'icon-gh-absent',
    });

    expect(res.status).toBe(201);
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
    const call = mockRegisterGitHub.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('projectMetadata' in call).toBe(false);
  });
});

describe('r2.ts icon wiring — POST /create-repo', () => {
  test('a valid icon is threaded into registerGitHubLinkedProject as projectMetadata.icon', async () => {
    const res = await post('/create-repo', {
      name: 'icon-create-repo-ok',
      icon: '🇺🇸',
    });

    expect(res.status).toBe(201);
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
    expect(mockRegisterGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ projectMetadata: { icon: '🇺🇸' } }),
    );
  });

  test('a two-grapheme icon reaches registerGitHubLinkedProject with NO projectMetadata key at all', async () => {
    const res = await post('/create-repo', {
      name: 'icon-create-repo-bad',
      icon: '🚀🚀',
    });

    expect(res.status).toBe(201);
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
    const call = mockRegisterGitHub.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('projectMetadata' in call).toBe(false);
  });
});
