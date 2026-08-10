/**
 * Task 4 wiring test for `metadata.icon_glyph` on `r2.ts`'s three create call
 * sites — `/link-repository` PAT path, `/link-repository` GitHub-App path,
 * and `/create-repo`. Mirrors `./r2-icon-wiring.test.ts`'s mocking shape
 * exactly: same fakes, same mocked `../lib/access`, `../../iam`, `../lib/git`,
 * `../github`, `../../snapshots/builder`, and `../lib/workspace-registration`
 * modules, so this file needs no database and no GitHub network access.
 *
 * `mock.module` is process-global in bun:test, so this file MUST stay
 * independent from `r2-icon-wiring.test.ts` — `--isolate` gives each test
 * file its own process (see scripts/test.sh). Both files are run together in
 * CI and in Task 4's own verification to prove the two mock modules do not
 * collide.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const FAKE_ACCOUNT_ID = '00000000-0000-4000-a000-000000009920';
const FAKE_USER_ID = '00000000-0000-4000-a000-000000009921';

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
  installationRowId: '00000000-0000-4000-a000-000000009922',
  accountId: FAKE_ACCOUNT_ID,
  installationId: '654321',
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
  installationId: '654321',
};

function fakeWorkspaceRow(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    workspaceId: `proj-${Math.random().toString(36).slice(2)}`,
    accountId: FAKE_ACCOUNT_ID,
    name: 'glyph-wiring-test',
    repoUrl: 'https://github.com/acme/glyph-wiring-test.git',
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

// ── Auth/quota/access — no DB. `resolveWorkspaceAccount` bypasses the real
// membership lookup entirely; `enforceWorkspaceQuota` always allows.
const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  resolveWorkspaceAccount: async () => ({ userId: FAKE_USER_ID, accountId: FAKE_ACCOUNT_ID }),
  enforceWorkspaceQuota: async () => null,
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
    repo: fakeRepo('glyph-pat-ok'),
    defaultBranch: 'main',
  }),
  resolveGitHubImport: async () => ({
    repo: fakeRepo('glyph-gh-ok'),
    installation: fakeInstallation,
    auth: fakeAuth,
    defaultBranch: 'main',
  }),
  resolveGitHubRepoAuth: async () => ({
    auth: fakeAuth,
    authSource: 'app_installation' as const,
    installation: fakeInstallation,
  }),
  getWorkspaceGitConnection: async () => null,
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
  kickWorkspaceTemplatePrebuilds: () => {},
}));

// ── The subject of this test: r2.ts's three call sites into these two
// functions. Mocked (not spread) so every call is captured.
const mockRegisterGitHub = mock(async (input: Record<string, unknown>) =>
  fakeWorkspaceRow({ metadata: (input.workspaceMetadata as Record<string, unknown>) ?? {} }),
);
const mockRegisterPat = mock(async (input: Record<string, unknown>) =>
  fakeWorkspaceRow({ metadata: (input.workspaceMetadata as Record<string, unknown>) ?? {} }),
);
mock.module('../lib/workspace-registration', () => ({
  registerGitHubLinkedWorkspace: mockRegisterGitHub,
  registerPatLinkedWorkspace: mockRegisterPat,
}));

// Registers r2.ts's routes onto the shared `workspaceRoutesApp` singleton. r1.ts
// (which attaches the `supabaseAuth` middleware) is deliberately NOT
// imported, so these requests need no Authorization header — auth itself is
// mocked out above via `assertAuthorized`.
const { workspaceRoutesApp } = await import('../lib/app');
await import('./r2');

function post(path: string, body: Record<string, unknown>) {
  return workspaceRoutesApp.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockRegisterGitHub.mockClear();
  mockRegisterPat.mockClear();
});

describe('r2.ts glyph wiring — POST /link-repository (PAT path)', () => {
  function postPat(body: Record<string, unknown>) {
    return post('/link-repository', {
      repo_url: 'https://github.com/acme/glyph-pat-ok.git',
      github_token: 'fake-user-pat',
      name: 'glyph-pat-ok',
      ...body,
    });
  }
  function lastCall() {
    return mockRegisterPat.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  test('a valid glyph reaches workspaceMetadata', async () => {
    const res = await postPat({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect(res.status).toBe(201);
    expect(mockRegisterPat).toHaveBeenCalledTimes(1);
    expect(mockRegisterGitHub).not.toHaveBeenCalled();
    expect(lastCall().workspaceMetadata).toEqual({ icon_glyph: { name: 'Rocket', color: 'blue' } });
  });

  test('a malformed glyph is dropped and the create still succeeds', async () => {
    const res = await postPat({ icon_glyph: { name: 'Skull', color: 'red' } });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toBeUndefined();
  });

  test('a glyph beats an emoji when both are sent', async () => {
    const res = await postPat({ icon: '🚀', icon_glyph: { name: 'Star', color: 'red' } });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toEqual({ icon_glyph: { name: 'Star', color: 'red' } });
  });

  test('an emoji alone still works — this path is unchanged', async () => {
    const res = await postPat({ icon: '🚀' });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toEqual({ icon: '🚀' });
  });
});

describe('r2.ts glyph wiring — POST /link-repository (GitHub App path)', () => {
  function postGithubApp(body: Record<string, unknown>) {
    return post('/link-repository', {
      repo_url: 'https://github.com/acme/glyph-gh-ok.git',
      name: 'glyph-gh-ok',
      ...body,
    });
  }
  function lastCall() {
    return mockRegisterGitHub.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  test('a valid glyph reaches workspaceMetadata', async () => {
    const res = await postGithubApp({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect(res.status).toBe(201);
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
    expect(mockRegisterPat).not.toHaveBeenCalled();
    expect(lastCall().workspaceMetadata).toEqual({ icon_glyph: { name: 'Rocket', color: 'blue' } });
  });

  test('a malformed glyph is dropped and the create still succeeds', async () => {
    const res = await postGithubApp({ icon_glyph: { name: 'Skull', color: 'red' } });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toBeUndefined();
  });

  test('a glyph beats an emoji when both are sent', async () => {
    const res = await postGithubApp({ icon: '🚀', icon_glyph: { name: 'Star', color: 'red' } });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toEqual({ icon_glyph: { name: 'Star', color: 'red' } });
  });

  test('an emoji alone still works — this path is unchanged', async () => {
    const res = await postGithubApp({ icon: '🚀' });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toEqual({ icon: '🚀' });
  });
});

describe('r2.ts glyph wiring — POST /create-repo', () => {
  function postCreateRepo(body: Record<string, unknown>) {
    return post('/create-repo', {
      name: 'glyph-create-repo',
      ...body,
    });
  }
  function lastCall() {
    return mockRegisterGitHub.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  test('a valid glyph reaches workspaceMetadata', async () => {
    const res = await postCreateRepo({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect(res.status).toBe(201);
    expect(mockRegisterGitHub).toHaveBeenCalledTimes(1);
    expect(lastCall().workspaceMetadata).toEqual({ icon_glyph: { name: 'Rocket', color: 'blue' } });
  });

  test('a malformed glyph is dropped and the create still succeeds', async () => {
    const res = await postCreateRepo({ icon_glyph: { name: 'Skull', color: 'red' } });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toBeUndefined();
  });

  test('a glyph beats an emoji when both are sent', async () => {
    const res = await postCreateRepo({ icon: '🚀', icon_glyph: { name: 'Star', color: 'red' } });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toEqual({ icon_glyph: { name: 'Star', color: 'red' } });
  });

  test('an emoji alone still works — this path is unchanged', async () => {
    const res = await postCreateRepo({ icon: '🚀' });
    expect(res.status).toBe(201);
    expect(lastCall().workspaceMetadata).toEqual({ icon: '🚀' });
  });
});
