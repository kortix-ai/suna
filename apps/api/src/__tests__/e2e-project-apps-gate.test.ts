/**
 * Verify the experimental flag gates the entire [[apps]] surface.
 *
 * Lives in its own file because `config` is module-loaded once per
 * bun-test process — to test the flag-off behavior we need a fresh
 * module graph with KORTIX_APPS_EXPERIMENTAL NOT set.
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, projectMembers, projects } from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

// CRITICAL: do NOT set KORTIX_APPS_EXPERIMENTAL. Default is false.
delete process.env.KORTIX_APPS_EXPERIMENTAL;

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Gate Project',
  repoUrl: 'https://github.com/kortix-ai/gate-project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function setTestAuth(userId = USER_ID, userEmail = 'gate@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}

function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'gate@example.test' };
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    await next();
  },
  combinedAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    await next();
  },
}));

mock.module('../projects/git', () => ({
  createRemoteSessionBranch: async () => {},
  archiveRepoSubtree: async () => undefined,
  listRepoFiles: async () => [],
  readRepoFile: async () => 'kortix_version = 1\n[project]\nname = "x"\n',
  loadProjectConfig: async () => ({ env: { required: [], optional: [] } }),
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  invalidateProjectMirror: () => {},
  resolveCommitSha: async () => 'a'.repeat(40),
  resolveBranchTip: async () => 'a'.repeat(40),
  getBranchDiff: async () => ({ files: [], diff: '' }),
  previewMerge: async () => ({ canMerge: true, conflicts: [] }),
  mergeBranches: async () => ({ mergedSha: 'a'.repeat(40) }),
}));

mock.module('../snapshots/builder', () => ({
  ensureBuildForLatestCommit: async () => ({ status: 'started', commitSha: 'a'.repeat(40) }),
  getLatestReadySnapshot: async () => null,
  listSnapshotsForProject: async () => [],
  buildSnapshotForCommit: async () => ({ daytonaName: '', commitSha: '', contentHash: '', built: false }),
  pruneOldSnapshots: async () => ({ deletedRows: 0, deletedDaytonaSnapshots: 0 }),
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => '',
  commitFile: async () => {},
  createInstallationToken: async () => ({ token: 't' }),
  createRepo: async () => { throw new Error('not used'); },
  deleteFile: async () => {},
  getFileSha: async () => null,
  getGitHubAppInstallation: async () => ({ account: { login: 'x', type: 'Organization' }, repository_selection: 'all', permissions: {} }),
  isGithubAppConfigured: () => false,
  isGithubPatConfigured: () => true,
}));

mock.module('../platform/services/session-sandbox', () => ({ provisionSessionSandbox: async () => {} }));
mock.module('../shared/resolve-account', () => ({ resolveAccountId: async () => ACCOUNT_ID }));
mock.module('../shared/supabase', () => ({
  getSupabase: () => ({ auth: { admin: { getUserById: async () => ({ data: { user: { email: 'gate@example.test' } } }) } } }),
}));
mock.module('../billing/repositories/credit-accounts', () => ({ getSubscriptionInfo: async () => ({ tier: 'free' }) }));
mock.module('../projects/secrets', () => ({
  encryptProjectSecret: (_p: string, v: string) => v,
  decryptProjectSecret: (_p: string, v: string) => v,
  isValidSecretName: () => true,
  listProjectSecrets: async () => ({}),
  getProjectSecretValue: async () => null,
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const result: any = [];
          result.orderBy = () => {
            const r: any[] = [];
            (r as any).limit = async () => [];
            return r;
          };
          result.limit = async () => {
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner', userId: USER_ID }];
            if (table === projectMembers) return [];
            return [];
          };
          (result as any).then = (resolve: (rows: any[]) => unknown) => {
            if (table === projects) resolve([projectRow]);
            else resolve([]);
          };
          return result;
        },
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [], then: (r: any) => r([]) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    delete: () => ({ where: async () => {} }),
  },
}));

const { projectsApp } = await import('../projects/index');
const { runProjectAppSweep } = await import('../projects/app-sweep');

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

describe('experimental gate — KORTIX_APPS_EXPERIMENTAL is off', () => {
  beforeEach(() => {
    setTestAuth();
    delete process.env.KORTIX_APPS_EXPERIMENTAL;
  });

  test('GET /apps → 404 with explanatory error', async () => {
    const res = await createApp().request(`/v1/projects/${PROJECT_ID}/apps`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/KORTIX_APPS_EXPERIMENTAL/);
  });

  test('POST /apps → 404 (no manifest commit attempted)', async () => {
    const res = await createApp().request(`/v1/projects/${PROJECT_ID}/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'x',
        domains: ['x.style.dev'],
        source: { type: 'git', repo: 'https://github.com/me/x' },
      }),
    });
    expect(res.status).toBe(404);
  });

  test('POST /apps/:slug/deploy → 404', async () => {
    const res = await createApp().request(`/v1/projects/${PROJECT_ID}/apps/x/deploy`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('runProjectAppSweep() is a no-op (returns empty counters)', async () => {
    const result = await runProjectAppSweep();
    expect(result).toEqual({
      scannedProjects: 0,
      scannedApps: 0,
      unchanged: 0,
      deployed: 0,
      failed: 0,
    });
  });
});
