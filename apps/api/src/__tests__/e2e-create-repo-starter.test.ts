import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountGithubInstallations,
  accountMembers,
  projectMembers,
  projects,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

// The starter is a folder under `packages/starter/templates/base/` —
// `getStarterFiles()` walks it and returns the files sorted by path
// (case-insensitive, via localeCompare). This list is the contract:
// "every project ships with these, in this order."
const SPEC_STARTER_PATHS = [
  '.gitignore',
  '.opencode/agents/kortix.md',
  '.opencode/opencode.jsonc',
  '.opencode/skills/kortix-system/SKILL.md',
  '.opencode/tools/show.ts',
  'Dockerfile',
  'kortix.toml',
  'README.md',
];

let repoCreateCalls: any[];
let fileShaCalls: any[];
let commitCalls: any[];
let insertedProject: any | null;
let grantedProjectRole: any | null;
let installationRow: typeof accountGithubInstallations.$inferSelect | null;

function setTestAuth(userId = USER_ID, userEmail = 'starter@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}

function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'starter@example.test' };
}

function resetState() {
  setTestAuth();
  repoCreateCalls = [];
  fileShaCalls = [];
  commitCalls = [];
  insertedProject = null;
  grantedProjectRole = null;
  installationRow = {
    accountId: ACCOUNT_ID,
    installationId: '42',
    ownerLogin: 'kortix-org',
    ownerType: 'Organization',
    repositorySelection: 'all',
    permissions: { contents: 'write' },
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    await next();
  },
}));

mock.module('../projects/git', () => ({
  createRemoteSessionBranch: async () => undefined,
  archiveRepoSubtree: async () => undefined,
  listRepoFiles: async () => [],
  loadProjectConfig: async () => ({ env: { required: [], optional: [] } }),
  readRepoFile: async () => '',
  invalidateProjectMirror: () => {},
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  deleteFile: async () => undefined,
  commitFile: async (input: any) => {
    commitCalls.push(input);
  },
  createInstallationToken: async (installationId: string) => {
    expect(installationId).toBe('42');
    return { token: 'installation-token', expires_at: '2026-01-01T00:00:00Z' };
  },
  createRepo: async (input: any) => {
    repoCreateCalls.push(input);
    return {
      id: 7,
      name: 'company-os',
      full_name: 'kortix-org/company-os',
      private: true,
      html_url: 'https://github.com/kortix-org/company-os',
      clone_url: 'https://github.com/kortix-org/company-os.git',
      ssh_url: 'git@github.com:kortix-org/company-os.git',
      default_branch: 'main',
      description: null,
    };
  },
  getFileSha: async (input: any) => {
    fileShaCalls.push(input);
    return input.path === 'README.md' ? 'existing-readme-sha' : null;
  },
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: { contents: 'write' },
  }),
  isGithubAppConfigured: () => true,
  isGithubPatConfigured: () => false,
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async () => undefined,
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'starter@example.test' } } }),
      },
    },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'free' }),
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === accountMembers) {
              return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
            }
            if (table === accountGithubInstallations) {
              return installationRow ? [installationRow] : [];
            }
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoUpdate: () => {
          if (table === projectMembers) {
            grantedProjectRole = values;
            return Promise.resolve([]);
          }
          return {
            returning: async () => {
              if (table === accountGithubInstallations) {
                installationRow = {
                  accountId: values.accountId,
                  installationId: values.installationId,
                  ownerLogin: values.ownerLogin,
                  ownerType: values.ownerType,
                  repositorySelection: values.repositorySelection ?? null,
                  permissions: values.permissions ?? {},
                  metadata: values.metadata ?? {},
                  createdAt: installationRow?.createdAt ?? new Date('2026-01-01T00:00:00Z'),
                  updatedAt: values.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
                };
                return [installationRow];
              }
              if (table !== projects) return [];
              insertedProject = values;
              return [{
                projectId: PROJECT_ID,
                accountId: values.accountId,
                name: values.name,
                repoUrl: values.repoUrl,
                defaultBranch: values.defaultBranch,
                manifestPath: values.manifestPath,
                status: values.status,
                metadata: values.metadata,
                lastOpenedAt: null,
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: values.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
              }];
            },
          };
        },
        returning: async () => {
          if (table !== projects) return [];
          insertedProject = values;
          return [{
            projectId: PROJECT_ID,
            accountId: values.accountId,
            name: values.name,
            repoUrl: values.repoUrl,
            defaultBranch: values.defaultBranch,
            manifestPath: values.manifestPath,
            status: values.status,
            metadata: values.metadata,
            lastOpenedAt: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: values.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
          }];
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === accountGithubInstallations) installationRow = null;
      },
    }),
  },
}));

const { projectsApp } = await import('../projects/index');
const { buildStarterFiles } = await import('../projects/starter');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('create-repo starter scaffold contract', () => {
  beforeEach(() => resetState());

  test('builds exactly the SPEC starter scaffold', () => {
    const files = buildStarterFiles({
      projectName: 'Company OS',
      repoFullName: 'kortix-org/company-os',
    });

    expect(files.map((file) => file.path)).toEqual(SPEC_STARTER_PATHS);
    expect(new Set(files.map((file) => file.path)).size).toBe(SPEC_STARTER_PATHS.length);
    expect(files.every((file) => file.content.trim().length > 0)).toBe(true);
  });

  test('manages account GitHub App installation metadata through the project API', async () => {
    const app = createApp();

    const installed = await app.request(`/v1/projects/github/installation?account_id=${ACCOUNT_ID}`);
    expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({
      account_id: ACCOUNT_ID,
      installed: true,
      configured: true,
      requires_installation: false,
      pat_fallback_available: false,
      installation_id: '42',
      owner_login: 'kortix-org',
      owner_type: 'Organization',
    });

    const upsert = await app.request('/v1/projects/github/installation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        installation_id: '42',
      }),
    });
    expect(upsert.status).toBe(200);
    expect(await upsert.json()).toMatchObject({
      installed: true,
      installation_id: '42',
      owner_login: 'kortix-org',
      permissions: { contents: 'write' },
    });

    const disconnect = await app.request(`/v1/projects/github/installation?account_id=${ACCOUNT_ID}`, {
      method: 'DELETE',
    });
    expect(disconnect.status).toBe(200);
    expect(await disconnect.json()).toEqual({ ok: true });
    expect(installationRow).toBeNull();

    const uninstalled = await app.request(`/v1/projects/github/installation?account_id=${ACCOUNT_ID}`);
    expect(uninstalled.status).toBe(200);
    expect(await uninstalled.json()).toMatchObject({
      account_id: ACCOUNT_ID,
      installed: false,
      configured: true,
      requires_installation: true,
      install_url: 'https://github.com/apps/kortix-test/installations/new',
    });
  });

  test('commits the exact starter scaffold with the account GitHub App token before registering the project', async () => {
    const app = createApp();
    const res = await app.request('/v1/projects/create-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'company-os',
        project_name: 'Company OS',
        private: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project_id).toBe(PROJECT_ID);
    expect(body.repo_url).toBe('https://github.com/kortix-org/company-os.git');
    expect(body.metadata.github.auth_source).toBe('app_installation');

    expect(repoCreateCalls).toHaveLength(1);
    expect(repoCreateCalls[0]).toMatchObject({
      name: 'company-os',
      isPrivate: true,
      autoInit: true,
      auth: {
        token: 'installation-token',
        source: 'app_installation',
        owner: 'kortix-org',
        ownerType: 'Organization',
        installationId: '42',
      },
    });
    expect(repoCreateCalls[0].owner).toBeUndefined();

    expect(fileShaCalls.map((call) => call.path)).toEqual(['README.md']);
    expect(fileShaCalls[0]).toMatchObject({
      owner: 'kortix-org',
      repo: 'company-os',
      branch: 'main',
      auth: { token: 'installation-token', source: 'app_installation' },
    });

    expect(commitCalls.map((call) => call.path)).toEqual(SPEC_STARTER_PATHS);
    expect(commitCalls.every((call) => call.auth?.token === 'installation-token')).toBe(true);
    expect(commitCalls.every((call) => call.branch === 'main')).toBe(true);
    expect(commitCalls.every((call) => call.message === `chore: scaffold ${call.path}`)).toBe(true);
    // README.md is upserted via sha because `auto_init: true` creates one
    // on repo creation. Every other file is brand-new.
    const readmeIdx = SPEC_STARTER_PATHS.indexOf('README.md');
    expect(commitCalls[readmeIdx]!.existingSha).toBe('existing-readme-sha');
    expect(commitCalls.filter((_, i) => i !== readmeIdx).every((call) => call.existingSha === undefined)).toBe(true);

    expect(insertedProject).toMatchObject({
      accountId: ACCOUNT_ID,
      name: 'Company OS',
      repoUrl: 'https://github.com/kortix-org/company-os.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.toml',
      status: 'active',
      metadata: {
        github: {
          full_name: 'kortix-org/company-os',
          html_url: 'https://github.com/kortix-org/company-os',
          private: true,
          auth_source: 'app_installation',
        },
      },
    });
    expect(grantedProjectRole).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      projectRole: 'manager',
      grantedBy: USER_ID,
    });
  });
});
