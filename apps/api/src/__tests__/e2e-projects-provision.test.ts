/**
 * E2E for `POST /v1/projects/provision` — the managed-git path behind
 * `kortix ship` when a repo has no `origin` remote. The managed backend is
 * provider-agnostic (GitHub is the default + only active one), so this test
 * drives the endpoint against a stub `GitHostBackend` and asserts the
 * provider-neutral behaviour: create repo → mint push token → register project.
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
const EXTERNAL_REPO_ID = 'gh-repo-1';
const INSTALL_ID = 'install-1';
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

// ─── Stub fetch: sandbox secret lookups 404 so keys resolve from env. ─────────

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (typeof url === 'string' && /\/env\//.test(url)) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }
  return originalFetch(input, init);
}) as typeof fetch;

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Stub managed git backend. The provision endpoint resolves the backend through
// `../projects/git-backends`; we register a single `github` backend whose
// `isConfigured()` we toggle to exercise the configured / not-configured paths.
let backendConfigured = true;
let createdSlug = '';
const backendCalls: string[] = [];

const stubBackend = {
  id: 'github',
  isConfigured: async () => backendConfigured,
  createRepo: async (input: any) => {
    backendCalls.push('createRepo');
    createdSlug = input.slug;
    return {
      provider: 'github',
      upstreamUrl: `https://github.com/${REPO_OWNER}/${input.slug}.git`,
      externalRepoId: EXTERNAL_REPO_ID,
      repoOwner: REPO_OWNER,
      repoName: input.slug,
      installationId: INSTALL_ID,
      credentialRef: null,
      defaultBranch: input.defaultBranch,
      initialToken: PUSH_TOKEN,
    };
  },
  deleteRepo: async () => { backendCalls.push('deleteRepo'); },
  buildUpstream: (ref: any) => ({ url: ref.upstreamUrl, headers: {} }),
  seedFiles: async () => { backendCalls.push('seedFiles'); },
};

mock.module('../projects/git-backends', () => ({
  hasBackend: (provider: string) => provider === 'github',
  getBackend: (provider: string) => (provider === 'github' ? stubBackend : stubBackend),
  getDefaultManagedBackend: () => stubBackend,
  githubBackend: stubBackend,
  managedGithubInstallId: () => INSTALL_ID,
  managedGithubToken: () => null,
}));

// Stub the Freestyle *deployments* provider (kept feature, unrelated to managed
// git) so loading the projects module graph doesn't drag real deployment code —
// and its transitive DB imports — into this lightweight test.
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
  kickProjectTemplatePrebuilds: () => {},
  reconcileStaleBuilds: async () => {},
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
  hasDatabase: true,
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

describe('POST /v1/projects/provision (managed git)', () => {
  beforeEach(() => {
    setTestAuth();
    insertedProject = null;
    grantedProjectRole = null;
    backendCalls.length = 0;
    backendConfigured = true;
  });

  test('provisions a managed repo + scoped token and registers the project', async () => {
    const app = createApp();
    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'My Agent' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    // Repo slug = readable name + the (server-generated) project id; the managed
    // repo lives under the managed org. Response carries the project + scoped
    // push token for the CLI.
    expect(createdSlug).toMatch(/^my-agent-[0-9a-f-]{36}$/);
    const expectedRepoUrl = `https://github.com/${REPO_OWNER}/${createdSlug}.git`;
    expect(body.project_id).toBe(PROJECT_ID);
    expect(body.repo_url).toBe(expectedRepoUrl);
    expect(body.repo_id).toBe(EXTERNAL_REPO_ID);
    expect(body.push_token).toBe(PUSH_TOKEN);

    // Persisted row records the canonical typed git-remote reference.
    expect(insertedProject).toMatchObject({
      accountId: ACCOUNT_ID,
      name: 'My Agent',
      repoUrl: expectedRepoUrl,
      defaultBranch: 'main',
      manifestPath: 'kortix.toml',
      status: 'active',
      metadata: {
        git: {
          url: expectedRepoUrl,
          provider: 'github',
          managed: true,
          auth: { method: 'github_app', installation_id: INSTALL_ID },
          owner: REPO_OWNER,
        },
      },
    });
    expect(grantedProjectRole).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      projectRole: 'manager',
    });

    // Provisioned the repo through the backend seam (no seeding without flag).
    expect(backendCalls).toEqual(['createRepo']);
  });

  test('returns 503 when managed git is not configured', async () => {
    backendConfigured = false;
    const app = createApp();
    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'My Agent' }),
    });
    expect(res.status).toBe(503);
    expect(backendCalls).toHaveLength(0);
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
});
