/**
 * E2E for `POST /v1/projects/provision` — the managed-git path behind
 * `kortix ship` when a repo has no `origin` remote. Mirrors the mock surface
 * of e2e-create-repo-starter.test.ts but swaps GitHub repo creation for a
 * stubbed Freestyle git API (repo + identity + permission + token).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, projectMembers, projects } from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const REPO_ID = 'repo-uuid-123';
const IDENTITY_ID = 'identity-uuid-456';
const PUSH_TOKEN = 'scoped-push-token-789';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

let insertedProject: any | null;
let grantedProjectRole: any | null;

function setTestAuth(userId = USER_ID, userEmail = 'ship@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}
function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'ship@example.test' };
}

// ─── Stub Freestyle git fetch ────────────────────────────────────────────────

const freestyleCalls: Array<{ path: string; method: string; body: unknown }> = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (typeof url === 'string' && url.includes('freestyle.sh')) {
    const path = new URL(url).pathname;
    let body: unknown = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { /* ignore */ }
    freestyleCalls.push({ path, method: init?.method ?? 'GET', body });

    let payload: unknown = {};
    if (path === '/git/v1/repo') payload = { repoId: REPO_ID, name: 'kortix-project', defaultBranch: 'main' };
    else if (path === '/git/v1/identity') payload = { identityId: IDENTITY_ID };
    else if (/\/permissions\//.test(path)) payload = {};
    else if (/\/tokens$/.test(path)) payload = { token: PUSH_TOKEN };

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }
  // sandbox secret lookups → 404 so the key resolves from env.
  if (typeof url === 'string' && /\/env\//.test(url)) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }
  return originalFetch(input, init);
}) as typeof fetch;

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Test-controlled Freestyle key so the "not configured" path is deterministic
// regardless of the host's real env/config. `callFreestyle` stays real enough
// to still hit the stubbed fetch above.
let freestyleKey = 'test-key';
mock.module('../deployments/providers/freestyle', () => ({
  getFreestyleApiKey: async () => freestyleKey,
  getFreestyleApiUrl: () => 'https://api.freestyle.sh',
  callFreestyle: async (path: string, options: { method: string; body?: unknown }) =>
    fetch(`https://api.freestyle.sh${path}`, {
      method: options.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freestyleKey}` },
      body: options.body ? JSON.stringify(options.body) : undefined,
    }),
  // Registry (deployments/providers/index) reads `.name` at module load.
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

// Bypass the IAM engine — it queries account-group tables with .innerJoin that
// this file's lightweight db mock doesn't model. Mock only the engine so the
// real ../iam barrel still re-exports actions, assertAuthorized, etc. We're
// verifying provision/delete behavior, not the access-control engine itself.
mockIamEngineAllowAll();

// grantProjectRole syncs IAM policy rows; no-op those (they hit tables the
// lightweight db mock doesn't model).
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

mock.module("../snapshots/builder", () => ({
  ensureSandboxImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
  deleteSandboxImage: async () => ({ deleted: false, snapshotName: "kortix-default-test", slug: "default" }),
  listSnapshotBuilds: async () => [],
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: "default", spec: {}, isDefault: true }),
  kickPreBuild: () => {},
  resolveCommitSha: async () => "a".repeat(40),
  DEFAULT_SANDBOX_SLUG: "default",
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async () => undefined,
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'ship@example.test' } } }) } },
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
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
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
              if (table !== projects) return [];
              insertedProject = values;
              return [projectRowFrom(values)];
            },
          };
        },
        returning: async () => {
          if (table !== projects) return [];
          insertedProject = values;
          return [projectRowFrom(values)];
        },
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

describe('POST /v1/projects/provision (managed Freestyle git)', () => {
  beforeEach(() => {
    setTestAuth();
    insertedProject = null;
    grantedProjectRole = null;
    freestyleCalls.length = 0;
    freestyleKey = 'test-key';
  });

  test('creates a Freestyle repo + scoped token and registers the project', async () => {
    const app = createApp();
    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'My Agent' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    // Response carries the project + the scoped push token for the CLI.
    expect(body.project_id).toBe(PROJECT_ID);
    expect(body.repo_url).toBe(`https://git.freestyle.sh/${REPO_ID}`);
    expect(body.repo_id).toBe(REPO_ID);
    expect(body.push_token).toBe(PUSH_TOKEN);

    // Persisted row records the canonical typed git-remote reference.
    expect(insertedProject).toMatchObject({
      accountId: ACCOUNT_ID,
      name: 'My Agent',
      repoUrl: `https://git.freestyle.sh/${REPO_ID}`,
      defaultBranch: 'main',
      manifestPath: 'kortix.toml',
      status: 'active',
      metadata: {
        git: {
          url: `https://git.freestyle.sh/${REPO_ID}`,
          provider: 'freestyle',
          auth: { method: 'managed', ref: IDENTITY_ID },
          repo_id: REPO_ID,
        },
      },
    });
    expect(grantedProjectRole).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      projectRole: 'manager',
    });

    // Exercised the full Freestyle git handshake, in order.
    const calls = freestyleCalls.map((c) => `${c.method} ${c.path}`);
    expect(calls).toEqual([
      'POST /git/v1/repo',
      'POST /git/v1/identity',
      `POST /git/v1/identity/${IDENTITY_ID}/permissions/${REPO_ID}`,
      `POST /git/v1/identity/${IDENTITY_ID}/tokens`,
    ]);
    // Repo created private with the requested default branch.
    expect(freestyleCalls[0]!.body).toMatchObject({ public: false, defaultBranch: 'main' });
    // Grant is write-scoped.
    expect(freestyleCalls[2]!.body).toMatchObject({ permission: 'write' });
  });

  test('returns 503 when managed git is not configured', async () => {
    freestyleKey = '';
    const app = createApp();
    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'My Agent' }),
    });
    expect(res.status).toBe(503);
    expect(freestyleCalls).toHaveLength(0);
  });

  test('rejects an unsupported provider', async () => {
    const app = createApp();
    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'My Agent', provider: 'gitlab' }),
    });
    expect(res.status).toBe(400);
  });

  test('deleteManagedRepo issues DELETE to the repo endpoint (rm --purge path)', async () => {
    const { deleteManagedRepo } = await import('../projects/freestyle-git');
    await deleteManagedRepo(REPO_ID);
    const del = freestyleCalls.find((c) => c.method === 'DELETE');
    expect(del?.path).toBe(`/git/v1/repo/${REPO_ID}`);
  });
});
