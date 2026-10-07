/**
 * Managed provisioning guards that a local stack cannot reach: it has no
 * managed git backend, so POST /provision answers 503 before any of this runs.
 * - A seed that leaves no default branch answers 502 and rolls the repository
 *   and the project row back (6dc118d740).
 * - The server-global managed GitHub PAT is never returned as a push token,
 *   by /provision or by /git-token (pentest finding, 705be76c1e).
 * PROJ-40 asserts the membership 403 and the unconfigured 503 over real HTTP.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamAssignments, mockIamEngineAllowAll, mockIamReadModels } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, projectGitConnections, projectMembers, projects } from '@kortix/db';

process.env.KORTIX_DEFAULT_MARKETPLACES = '';
process.env.MANAGED_GIT_PROVIDER = 'github';

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
let updatedProjectSets: any[];
let seedFilePaths: string[];
let seedBaseFilePaths: string[];
let seedFilesByPath: Map<string, string>;
let canonicalMembership: boolean;
let managedPat: string | null;
let provisionedInitialToken: string | null;
let remoteBranchAfterSeed: boolean;

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
      initialToken: provisionedInitialToken,
    };
  },
  deleteRepo: async () => { backendCalls.push('deleteRepo'); },
  buildUpstream: (ref: any, token: string | null) => ({
    url: ref.upstreamUrl,
    headers: token
      ? { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }
      : {},
  }),
  seedFiles: async (_ref: any, _token: string, files: Array<{ path: string; content: string }>, opts: { baseFiles?: Array<{ path: string; content: string }> }) => {
    backendCalls.push('seedFiles');
    seedFilePaths = files.map((file) => file.path).sort();
    seedBaseFilePaths = (opts.baseFiles ?? []).map((file) => file.path).sort();
    seedFilesByPath = new Map(files.map((file) => [file.path, file.content] as const));
  },
};

mock.module('../projects/git-backends', () => ({
  defaultManagedProviderId: () => 'github',
  hasBackend: (provider: string) => provider === 'github',
  getBackend: (provider: string) => (provider === 'github' ? stubBackend : stubBackend),
  getDefaultManagedBackend: () => stubBackend,
  githubBackend: stubBackend,
  isRetiredManagedProvider: () => false,
  managedGithubInstallId: () => INSTALL_ID,
  managedGithubOwner: () => REPO_OWNER,
  managedGithubOwnerType: () => undefined,
  managedGithubToken: () => managedPat,
  parseBasicAuthHeader: (value?: string | null) => {
    if (!value?.startsWith('Basic ')) return null;
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator > 0
      ? { username: decoded.slice(0, separator), token: decoded.slice(separator + 1) }
      : null;
  },
}));

const realAuthMiddleware = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuthMiddleware,
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

// The read models answer from the same `canonicalMembership` switch the db shim
// uses for `account_members`, so the "no membership in that account" case still
// reaches the 403 it asserts.
mockIamReadModels({
  members: () =>
    canonicalMembership ? [{ userId: USER_ID, accountId: ACCOUNT_ID, accountRole: 'owner' }] : [],
});
// `grantProjectRole` IS one `assignRole` call now, and it is no longer
// best-effort — it writes `role_assignments`, which this file's lightweight db
// mock does not model. Bypass the write path; the provision behaviour under test
// is unaffected by where the grant lands.
mockIamAssignments({
  onGrant: (input) => {
    if (input.scope.type !== 'project') return;
    grantedProjectRole = {
      accountId: input.accountId,
      projectId: input.scope.id,
      userId: input.principal.id,
      projectRole: input.roleKey,
      grantedBy: (input as { grantedBy?: string | null }).grantedBy ?? null,
    };
  },
});

mock.module('../projects/git', () => ({
  MergeConflictError: class MergeConflictError extends Error {},
  isRepoFileNotFoundError: () => false,
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  createRemoteSessionBranch: async () => undefined,
  archiveRepoSubtree: async () => undefined,
  listRepoFiles: async () => [],
  loadProjectConfig: async () => ({ env: { required: [], optional: [] } }),
  readRepoFile: async () => '',
  readRepoFileBytes: async () => Buffer.alloc(0),
  readManifestFromRepo: async () => null,
  invalidateProjectMirror: () => {},
  remoteBranchExists: async () => remoteBranchAfterSeed,
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  resolveCommitSha: async () => 'a'.repeat(40),
  resolveFastBootGitHint: async () => ({ baseSha: 'a'.repeat(40) }),
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
  resolveBranchAheadState: async () => ({ ahead: false, commitsAhead: 0 }),
}));

mock.module("../snapshots/builder", () => ({
  ensureSandboxImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
  ensureMetaSandboxImage: async () => ({ snapshotName: "kortix-meta-test", slug: "meta", contentHash: "b".repeat(64), built: false, isDefault: false }),
  deleteSandboxImage: async () => ({ deleted: false, snapshotName: "kortix-default-test", slug: "default" }),
  listSnapshotBuilds: async () => [],
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: "default", spec: {}, isDefault: true }),
  kickPreBuild: () => {},
  kickRoutedPreBuild: () => {},
  templateBuildProviders: () => ['daytona', 'platinum', 'e2b'],
  kickProjectTemplatePrebuilds: () => {},
  kickStartupPreBuild: () => {},
  reconcileProjectTemplates: async () => ({ checked: 0, updated: 0 }),
  reconcileStaleBuilds: async () => ({ checked: 0, updated: 0 }),
  ensurePlatformDefaultImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
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
  upsertCreditAccount: async () => {},
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

function existingProjectRow() {
  return projectRowFrom({
    accountId: ACCOUNT_ID,
    name: 'Existing Managed Project',
    repoUrl: `https://github.com/${REPO_OWNER}/existing-managed.git`,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: {
      git: {
        url: `https://github.com/${REPO_OWNER}/existing-managed.git`,
        provider: 'github',
        managed: true,
        auth: { method: 'github_app', installation_id: INSTALL_ID },
        owner: REPO_OWNER,
      },
    },
  });
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (projection?: any) => ({
      from: (table: unknown) => ({
        where: () => {
          // The project-limit guard's count(*) query is awaited directly
          // (no .limit()). 0 keeps provision under any plan's cap.
          if (table === projects && projection && typeof projection === 'object' && 'count' in projection) {
            return Promise.resolve([{ count: 0 }]);
          }
          return {
            limit: async () => {
              if (table === accountMembers) {
                if (canonicalMembership) {
                  return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
                }
                return [];
              }
              if (table === projectMembers) {
                return [{ projectRole: 'manager' }];
              }
              if (table === projects) {
                return [existingProjectRow()];
              }
              if (table === projectGitConnections) {
                return [{
                  accountId: ACCOUNT_ID,
                  projectId: PROJECT_ID,
                  provider: 'github',
                  repoUrl: `https://github.com/${REPO_OWNER}/existing-managed.git`,
                  upstreamUrl: `https://github.com/${REPO_OWNER}/existing-managed.git`,
                  managed: true,
                  repoOwner: REPO_OWNER,
                  repoName: 'existing-managed',
                  externalRepoId: EXTERNAL_REPO_ID,
                  defaultBranch: 'main',
                  authMethod: 'github_app',
                  installationId: INSTALL_ID,
                  credentialRef: null,
                  permissions: {},
                  visibility: 'private',
                  webhookId: null,
                  status: 'connected',
                  metadata: {},
                  createdAt: new Date('2026-01-01T00:00:00Z'),
                  updatedAt: new Date('2026-01-01T00:00:00Z'),
                }];
              }
              return [];
            },
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoNothing: () => {
          return Promise.resolve([]);
        },
        onConflictDoUpdate: () => {
          if (table === projects) {
            throw new Error('managed project provisioning must insert a fresh project row');
          }
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
    update: (table: unknown) => ({
      set: (values: any) => ({
        where: () => {
          if (table === projects) updatedProjectSets.push(values);
          // Real drizzle's UPDATE builder is thenable at every chain step
          // (a caller may `.catch()` it directly without `.returning()` —
          // see projects.ts's best-effort default_agent metadata mirror write, and
          // the several other `.where(...).catch(() => {})` call sites this
          // mirrors), so this stub must be too: a real Promise (which
          // supplies `.then`/`.catch`) that ALSO exposes `.returning()` for
          // callers that chain it.
          const result: any = Promise.resolve([]);
          result.returning = async () => [];
          return result;
        },
      }),
    }),
    delete: () => ({ where: async () => {} }),
  },
}));

const { projectsApp, registerAllProjectRoutes } = await import('../projects/index');
registerAllProjectRoutes();

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
    updatedProjectSets = [];
    grantedProjectRole = null;
    seedFilePaths = [];
    seedBaseFilePaths = [];
    seedFilesByPath = new Map();
    canonicalMembership = true;
    backendCalls.length = 0;
    backendConfigured = true;
    managedPat = null;
    provisionedInitialToken = PUSH_TOKEN;
    remoteBranchAfterSeed = true;
  });

  test('does not report an active project when the seed pushed but left no default branch', async () => {
    remoteBranchAfterSeed = false;

    const app = createApp();
    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'Silently Empty',
        seed_starter: true,
        starter_template: 'minimal',
      }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('main');
    expect(body.code).toBe('seed_verification_failed');

    // The orphan repo + project row are rolled back, so no user can land in a
    // structurally empty project that claims to be active.
    expect(backendCalls).toContain('deleteRepo');
  });

  test('does not return the server-global managed GitHub PAT as a provision push token', async () => {
    provisionedInitialToken = null;
    managedPat = 'server-global-ghp-token';

    const app = createApp();
    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'PAT Fallback Project' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.push_token).toBeNull();
  });

  test('git-token fails closed when managed GitHub auth resolves to server-global PAT fallback', async () => {
    managedPat = 'server-global-ghp-token';

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/git-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    // Fails closed AND points at the path that actually works: the org-wide
    // token is never exported, clients push through the git proxy origin.
    expect(body.error).toContain('org-wide token');
    expect(body.error).toContain('git_origin_url');
    expect(body.git_origin_url).toBeTruthy();
  });

});

// GET /v1/projects/managed-git/status — lets the create-project UI pre-check
// whether the managed-git ("Create project") path is usable before hitting
// the 503, so it can disable/annotate that option gracefully instead of
// surfacing a raw server error (self-host with no MANAGED_GIT_* configured is
// the primary case this exists for).
