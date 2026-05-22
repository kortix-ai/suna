/**
 * End-to-end coverage for the per-project snapshot HTTP surface that
 * replaces the DAYTONA_SNAPSHOT env-var fallback.
 *
 * Contract under test:
 *   GET  /v1/projects/:id/snapshots
 *     - returns history rows + default_branch + head_commit_sha
 *     - tolerates head_commit_sha resolution errors (returns null +
 *       head_resolve_error string, never throws)
 *   POST /v1/projects/:id/snapshots/rebuild
 *     - returns the bucket label from ensureBuildForLatestCommit
 *       (already-ready / already-building / started / failed-to-start)
 *     - 403s when the caller is not an account manager
 *     - 502s when the build kick fails (failed-to-start path)
 *
 * The snapshot builder, GitHub auth, and the snapshots IIFE are
 * stubbed — we're testing the HTTP contract, not the build pipeline.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountGithubInstallations,
  accountMembers,
  projects,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

let listSnapshotCalls: Array<{ projectId: string }> = [];
let ensureBuildCalls: Array<{ projectId: string; branch: string; source: string }> = [];
let mockSnapshots: Array<Record<string, unknown>> = [];
let mockHeadCommitSha: string | null = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
let mockHeadResolveError: string | null = null;
let ensureBuildResult: { status: string; commitSha?: string; error?: string } = {
  status: 'started',
  commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
let accountRole: 'owner' | 'admin' | 'member' = 'owner';

function setTestAuth(userId = USER_ID, userEmail = 'snap@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}

function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID };
}

mock.module('../iam/engine', () => ({
  // Mirror the legacy role gate so denial tests still exercise authz: managers
  // (owner/admin) pass everything; others only get reads.
  authorize: async (_u: unknown, _a: unknown, action: string) => ({
    allowed: accountRole === 'owner' || accountRole === 'admin' || action === 'project.read',
  }),
  assertAuthorized: async () => {},
  listAccessibleResources: async () => ({ mode: 'all', ids: [] }),
}));

mockIamMembershipSyncNoop();

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    await next();
  },
}));

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
  resolveCommitSha: async () => {
    if (mockHeadResolveError) throw new Error(mockHeadResolveError);
    if (mockHeadCommitSha === null) throw new Error('no head');
    return mockHeadCommitSha;
  },
  resolveBranchTip: async () => 'a'.repeat(40),
  getBranchDiff: async () => ({ files: [], diff: '' }),
  getDiffBetweenShas: async () => ({ files: [], diff: '' }),
  previewMerge: async () => ({ canMerge: true, conflicts: [] }),
  mergeBranches: async () => ({ mergedSha: 'a'.repeat(40) }),
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  verifyGitHubAppInstallState: (state: string) => state,
  verifyGitHubAppInstallStatePayload: (state: string) => ({
    accountId: state,
    nonce: 'test-nonce',
    issuedAt: Math.floor(Date.now() / 1000),
  }),
  getGitHubPatAuthContext: () => null,
  isGithubAppConfigured: () => true,
  isGithubPatConfigured: () => false,
  githubAppSlug: () => 'kortix-test',
  normalizeGitHubPrivateKey: (v: string) => v,
  createGitHubAppJwt: () => 'fake-jwt',
  createInstallationToken: async () => ({ token: 'tok', expires_at: '2099-01-01T00:00:00Z' }),
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: { contents: 'write' },
  }),
  createRepo: async () => ({
    id: 1, name: 'r', full_name: 'o/r', private: true,
    html_url: '', clone_url: '', ssh_url: '', default_branch: 'main', description: null,
  }),
  commitFile: async () => undefined,
  deleteFile: async () => undefined,
  getFileSha: async () => null,
  getRepo: async () => ({
    id: 1,
    name: 'snap-test',
    full_name: 'kortix-org/snap-test',
    private: true,
    html_url: 'https://github.com/kortix-org/snap-test',
    clone_url: 'https://github.com/kortix-org/snap-test.git',
    ssh_url: 'git@github.com:kortix-org/snap-test.git',
    default_branch: 'main',
    description: null,
  }),
  listInstallationRepositories: async () => [],
}));

mock.module('../snapshots/builder', () => ({
  listSnapshotsForProject: async (projectId: string) => {
    listSnapshotCalls.push({ projectId });
    return mockSnapshots;
  },
  ensureBuildForLatestCommit: async (project: any, opts: any) => {
    ensureBuildCalls.push({
      projectId: project.projectId,
      branch: opts.branch,
      source: opts.source,
    });
    return ensureBuildResult;
  },
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async () => undefined,
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'snap@example.test' } } }) } },
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
            if (table === projects) {
              return [{
                projectId: PROJECT_ID,
                accountId: ACCOUNT_ID,
                name: 'Snapshot Test',
                repoUrl: 'https://github.com/kortix-org/snap-test.git',
                defaultBranch: 'main',
                manifestPath: 'kortix.toml',
                status: 'active',
                metadata: {},
                lastOpenedAt: null,
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-01T00:00:00Z'),
              }];
            }
            if (table === accountMembers) {
              return [{ accountId: ACCOUNT_ID, accountRole }];
            }
            if (table === accountGithubInstallations) {
              return [{
                installationRowId: '00000000-0000-4000-a000-000000000041',
                accountId: ACCOUNT_ID,
                installationId: '42',
                ownerLogin: 'kortix-org',
                ownerType: 'Organization',
                repositorySelection: 'all',
                permissions: { contents: 'write' },
                metadata: {},
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-01T00:00:00Z'),
              }];
            }
            return [];
          },
        }),
      }),
    }),
  },
}));

const { projectsApp } = await import('../projects/index');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('GET /v1/projects/:projectId/snapshots', () => {
  beforeEach(() => {
    setTestAuth();
    listSnapshotCalls = [];
    ensureBuildCalls = [];
    mockSnapshots = [];
    mockHeadCommitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    mockHeadResolveError = null;
    accountRole = 'owner';
  });

  test('returns history rows, default branch, and resolved HEAD', async () => {
    mockSnapshots = [
      {
        snapshotRowId: 'r1',
        projectId: PROJECT_ID,
        provider: 'daytona',
        commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        branch: 'main',
        snapshotId: 'kortix-snap-1111-abcd',
        status: 'ready',
        error: null,
        metadata: { source: 'project-create' },
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:01:00Z'),
      },
    ];

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/snapshots`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.default_branch).toBe('main');
    expect(body.head_commit_sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(body.head_resolve_error).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].snapshot_row_id).toBe('r1');
    expect(body.items[0].status).toBe('ready');
    expect(listSnapshotCalls).toEqual([{ projectId: PROJECT_ID }]);
  });

  test('returns head_resolve_error when HEAD lookup fails (non-fatal)', async () => {
    mockHeadResolveError = 'GitHub App not installed';

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/snapshots`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.head_commit_sha).toBeNull();
    expect(body.head_resolve_error).toBe('GitHub App not installed');
    expect(body.items).toEqual([]);
  });
});

describe('POST /v1/projects/:projectId/snapshots/rebuild', () => {
  beforeEach(() => {
    setTestAuth();
    listSnapshotCalls = [];
    ensureBuildCalls = [];
    mockSnapshots = [];
    mockHeadCommitSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    mockHeadResolveError = null;
    ensureBuildResult = {
      status: 'started',
      commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    accountRole = 'owner';
  });

  test('forwards ensureBuildForLatestCommit result for managers', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/snapshots/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('started');
    expect(body.commit_sha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(body.branch).toBe('main');
    expect(ensureBuildCalls).toHaveLength(1);
    expect(ensureBuildCalls[0].source).toBe('manual');
  });

  test('returns 403 for non-managers', async () => {
    accountRole = 'member';
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/snapshots/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    // 403 (project access) — member role is below 'manage' for this project.
    expect(res.status).toBe(403);
    expect(ensureBuildCalls).toHaveLength(0);
  });

  test('returns 502 when ensureBuildForLatestCommit reports failed-to-start', async () => {
    ensureBuildResult = { status: 'failed-to-start', error: 'github auth failed' };
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/snapshots/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error).toBe('github auth failed');
  });
});
