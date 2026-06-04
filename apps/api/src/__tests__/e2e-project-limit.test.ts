/**
 * E2E for the per-account PROJECT LIMIT — the guard that stops a free account
 * from creating an unbounded number of projects. Free accounts get 1 project;
 * any paid plan gets the effectively-uncapped `MAX_PROJECTS_PER_ACCOUNT`.
 *
 * This drives the real `POST /v1/projects/provision` handler (and its real
 * `enforceProjectQuota` chokepoint) against a stubbed managed-git backend and a
 * db mock with a configurable project count. The limit *number* itself comes
 * from `maxProjectsForAccount` (mocked here to a controllable value — its
 * plan→number policy is covered by `unit-project-limit-policy.test.ts`); what
 * this file proves is the enforcement wiring: at-limit → 403 before any repo is
 * created; under-limit → 201.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, projectMembers, projects } from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const REPO_OWNER = 'kortix-managed';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

// ─── Per-test knobs ───────────────────────────────────────────────────────────
let projectLimit = 1; // what maxProjectsForAccount returns for the account
let projectCount = 0; // how many projects the account already owns (count(*))

function setTestAuth(userId = USER_ID, userEmail = 'limit@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}
function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'limit@example.test' };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (typeof url === 'string' && /\/env\//.test(url)) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }
  return originalFetch(input, init);
}) as typeof fetch;

// ─── Stub managed git backend ────────────────────────────────────────────────
const backendCalls: string[] = [];
const stubBackend = {
  id: 'github',
  isConfigured: async () => true,
  createRepo: async (input: any) => {
    backendCalls.push('createRepo');
    return {
      provider: 'github',
      upstreamUrl: `https://github.com/${REPO_OWNER}/${input.slug}.git`,
      externalRepoId: 'gh-repo-1',
      repoOwner: REPO_OWNER,
      repoName: input.slug,
      installationId: 'install-1',
      credentialRef: null,
      defaultBranch: input.defaultBranch,
      initialToken: 'scoped-push-token-789',
    };
  },
  deleteRepo: async () => { backendCalls.push('deleteRepo'); },
  buildUpstream: (ref: any) => ({ url: ref.upstreamUrl, headers: {} }),
  seedFiles: async () => { backendCalls.push('seedFiles'); },
};

mock.module('../projects/git-backends', () => ({
  hasBackend: (provider: string) => provider === 'github',
  getBackend: () => stubBackend,
  getDefaultManagedBackend: () => stubBackend,
  githubBackend: stubBackend,
  managedGithubInstallId: () => 'install-1',
  managedGithubToken: () => null,
}));

// The limit *number* is controlled here; the plan→number policy lives in the
// real maxProjectsForAccount (see unit-project-limit-policy.test.ts).
mock.module('../shared/account-limits', () => ({
  maxProjectsForAccount: async () => projectLimit,
  maxConcurrentSessionsForTier: () => Number.MAX_SAFE_INTEGER,
  resolveAccountTier: async () => 'free',
  sessionLlmPolicyForTier: () => ({ limit: 60, windowMs: 60_000 }),
  clearAccountLimitCache: () => {},
  FREE_TIER_PROJECT_LIMIT: 1,
}));

mock.module('../deployments/providers/freestyle', () => ({
  getFreestyleApiKey: async () => 'test-key',
  getFreestyleApiUrl: () => 'https://api.freestyle.sh',
  callFreestyle: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  freestyleProvider: { name: 'freestyle', deploy: async () => ({}), stop: async () => {}, logs: async () => ({}) },
}));

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    await next();
  },
}));

mockIamEngineAllowAll();
mockIamMembershipSyncNoop();

mock.module('../projects/git', () => ({
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
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
  resolveCommitSha: async () => 'a'.repeat(40),
  resolveTreeOid: async () => 'b'.repeat(40),
  materializeRepoContext: async () => '/tmp/fake-snapshot-context',
  resolveBranchTip: async () => 'a'.repeat(40),
  getBranchDiff: async () => ({ files: [], diff: '' }),
  getDiffBetweenShas: async () => ({ files: [], diff: '' }),
  previewMerge: async () => ({ canMerge: true, conflicts: [] }),
  mergeBranches: async () => ({ mergedSha: 'a'.repeat(40) }),
  commitFileToBranch: async () => ({ commitSha: 'a'.repeat(40) }),
  deleteRemoteSessionBranch: async () => undefined,
  diffStat: async () => ({ files: [], additions: 0, deletions: 0 }),
  getFileAtRef: async () => null,
  getMergeBase: async () => 'a'.repeat(40),
}));

mock.module('../snapshots/builder', () => ({
  ensureSandboxImage: async () => ({ snapshotName: 'kortix-default-test', slug: 'default', contentHash: 'a'.repeat(64), built: false, isDefault: true }),
  deleteSandboxImage: async () => ({ deleted: false, snapshotName: 'kortix-default-test', slug: 'default' }),
  listSnapshotBuilds: async () => [],
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: 'default', spec: {}, isDefault: true }),
  kickPreBuild: () => {},
  kickProjectTemplatePrebuilds: () => {},
  kickStartupPreBuild: () => {},
  reconcileProjectTemplates: async () => ({ checked: 0, updated: 0 }),
  reconcileStaleBuilds: async () => ({ checked: 0, updated: 0 }),
  ensurePlatformDefaultImage: async () => ({ snapshotName: 'kortix-default-test', slug: 'default', contentHash: 'a'.repeat(64), built: false, isDefault: true }),
  resolveCommitSha: async () => 'a'.repeat(40),
  DEFAULT_SANDBOX_SLUG: 'default',
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async () => undefined,
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'limit@example.test' } } }) } },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'free' }),
  getCreditAccount: async () => null,
  getCreditBalance: async () => ({ balance: 0, granted: 0, used: 0 }),
  updateCreditAccount: async () => {},
}));

function projectRowFrom(values: any) {
  return {
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
  };
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    // `projection` lets us distinguish the count(*) quota query from the
    // membership / row lookups, which use `.where().limit()`.
    select: (projection?: any) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === projects && projection && typeof projection === 'object' && 'count' in projection) {
            // The enforceProjectQuota count(*) query is awaited directly.
            return Promise.resolve([{ count: projectCount }]);
          }
          return {
            limit: async () => {
              if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
              return [];
            },
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoUpdate: () => {
          if (table === projectMembers) return Promise.resolve([]);
          return { returning: async () => (table === projects ? [projectRowFrom(values)] : []) };
        },
        returning: async () => (table === projects ? [projectRowFrom(values)] : []),
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    delete: () => ({ where: async () => {} }),
  },
}));

const { projectsApp } = await import('../projects/index');

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

function provision(name = 'Limited Agent') {
  return createApp().request('/v1/projects/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: ACCOUNT_ID, name }),
  });
}

describe('project limit — POST /v1/projects/provision', () => {
  beforeEach(() => {
    setTestAuth();
    backendCalls.length = 0;
    projectLimit = 1;
    projectCount = 0;
  });

  test('free account creates its first project (count 0 < limit 1) → 201', async () => {
    projectLimit = 1;
    projectCount = 0;
    const res = await provision();
    expect(res.status).toBe(201);
    expect(backendCalls).toEqual(['createRepo']);
  });

  test('free account at its limit (count 1 ≥ limit 1) → 403, no repo created', async () => {
    projectLimit = 1;
    projectCount = 1;
    const res = await provision();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('project_limit_reached');
    expect(body.limit).toBe(1);
    expect(body.count).toBe(1);
    expect(body.error).toContain('Free accounts are limited to 1 project');
    // Blocked BEFORE the managed repo is provisioned — no orphaned upstream repo.
    expect(backendCalls).toHaveLength(0);
  });

  test('paid plan creates well beyond the free limit (count 5 < limit 200) → 201', async () => {
    projectLimit = 200;
    projectCount = 5;
    const res = await provision();
    expect(res.status).toBe(201);
    expect(backendCalls).toEqual(['createRepo']);
  });

  test('paid plan at its (large) cap (count 200 ≥ limit 200) → 403', async () => {
    projectLimit = 200;
    projectCount = 200;
    const res = await provision();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('project_limit_reached');
    expect(body.error).toContain('limit of 200 projects');
    expect(backendCalls).toHaveLength(0);
  });

  test('billing disabled lifts the cap entirely (limit = MAX_SAFE_INTEGER) → 201', async () => {
    projectLimit = Number.MAX_SAFE_INTEGER;
    projectCount = 9999;
    const res = await provision();
    expect(res.status).toBe(201);
    expect(backendCalls).toEqual(['createRepo']);
  });
});
