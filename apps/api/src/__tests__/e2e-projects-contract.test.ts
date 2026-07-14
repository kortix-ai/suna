import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  baseDate,
  createProjectsContractDbMock,
  projectRow,
  type ProjectRow,
  type ProjectsContractDbState,
} from './helpers/projects-contract-db-mock';

const OWNER_ID = '00000000-0000-4000-a000-000000000001';
const MEMBER_ID = '00000000-0000-4000-a000-000000000002';
const OUTSIDER_ID = '00000000-0000-4000-a000-000000000003';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const OTHER_PROJECT_ID = '00000000-0000-4000-a000-000000000202';
const NEW_PROJECT_ID = '00000000-0000-4000-a000-000000000203';
const SECOND_NEW_PROJECT_ID = '00000000-0000-4000-a000-000000000205';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

const repoFiles = [
  { path: 'README.md', type: 'file', size: 18 },
  { path: 'kortix.yaml', type: 'file', size: 42 },
  { path: '.kortix/opencode/opencode.jsonc', type: 'file', size: 90 },
  { path: '.kortix/opencode/agents/default.md', type: 'file', size: 120 },
];

let currentUserId: string;
let currentUserEmail: string;
const dbState: ProjectsContractDbState = {
  accountMemberRows: [],
  projectRows: [],
  projectMemberRows: [],
  installationRow: null,
  gitConnectionRows: [],
  nextProjectIds: [],
};
let commitCalls: any[];
let listRepoFileCalls: any[];
let readRepoFileCalls: any[];
let archiveCalls: any[];
let rejectedBranch: string | null;

function setCurrentUser(userId: string, userEmail: string) {
  currentUserId = userId;
  currentUserEmail = userEmail;
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}

function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: currentUserId, userEmail: currentUserEmail };
}

function resetState() {
  setCurrentUser(OWNER_ID, 'owner@example.test');
  dbState.accountMemberRows = [
    { userId: OWNER_ID, accountId: ACCOUNT_ID, accountRole: 'owner', joinedAt: baseDate },
    { userId: MEMBER_ID, accountId: ACCOUNT_ID, accountRole: 'member', joinedAt: baseDate },
  ];
  dbState.projectRows = [
    projectRow(),
    projectRow({
      projectId: OTHER_PROJECT_ID,
      name: 'Other Project',
      repoUrl: 'https://github.com/kortix/other-project.git',
    }),
    projectRow({
      projectId: '00000000-0000-4000-a000-000000000204',
      name: 'Archived Project',
      repoUrl: 'https://github.com/kortix/archived-project.git',
      status: 'archived',
    }),
  ];
  dbState.projectMemberRows = [];
  dbState.installationRow = {
    installationRowId: '00000000-0000-4000-a000-000000000041',
    accountId: ACCOUNT_ID,
    installationId: '42',
    ownerLogin: 'kortix-org',
    ownerType: 'Organization',
    repositorySelection: 'all',
    permissions: { contents: 'write' },
    metadata: {},
    createdAt: baseDate,
    updatedAt: baseDate,
  };
  dbState.gitConnectionRows = [];
  dbState.nextProjectIds = [NEW_PROJECT_ID, SECOND_NEW_PROJECT_ID];
  commitCalls = [];
  listRepoFileCalls = [];
  readRepoFileCalls = [];
  archiveCalls = [];
  rejectedBranch = null;
}

// `authorize` / `assertAuthorized` / `listAccessibleResources` are re-exported
// from `../iam` via `./dispatcher` (the V1 `./engine` was retired), so the role
// gate must be mocked on the dispatcher. Mirror the legacy role gate against
// the test's mocked membership rows so viewer/non-member denial is still
// exercised after the IAM-engine switch.
mock.module('../iam/dispatcher', () => {
  const isManager = (userId: string): boolean => {
    const am = dbState.accountMemberRows.find((r) => r.userId === userId && r.accountId === ACCOUNT_ID);
    return am?.accountRole === 'owner' || am?.accountRole === 'admin';
  };
  const decide = (userId: string, action: string): boolean => {
    const am = dbState.accountMemberRows.find((r) => r.userId === userId && r.accountId === ACCOUNT_ID);
    if (!am) return false;
    if (am.accountRole === 'owner' || am.accountRole === 'admin') return true;
    const pm = dbState.projectMemberRows.find((r) => r.userId === userId && r.projectId === PROJECT_ID);
    const pr = pm?.projectRole ?? null;
    if (action === 'project.read') return pr === 'member' || pr === 'editor' || pr === 'manager';
    // Session lifecycle: any project member (a plain `member` included) may run sessions.
    if (action.startsWith('project.session.')) return pr === 'member' || pr === 'editor' || pr === 'manager';
    if (action === 'project.write') return pr === 'editor' || pr === 'manager';
    return pr === 'manager';
  };
  return {
    authorize: async (userId: string, _a: unknown, action: string) => ({ allowed: decide(userId, action) }),
    assertAuthorized: async (userId: string, _a: unknown, action: string) => {
      if (!decide(userId, action)) throw new HTTPException(403, { message: 'Forbidden' });
    },
    // Account managers see every project ('all'); members see only the projects
    // they hold an explicit grant on ('allow_only'); outsiders see none.
    listAccessibleResources: async (userId: string) => {
      const am = dbState.accountMemberRows.find((r) => r.userId === userId && r.accountId === ACCOUNT_ID);
      if (!am) return { mode: 'none', allowed: new Set<string>() };
      if (isManager(userId)) return { mode: 'all', allowed: new Set<string>() };
      const allowed = new Set(
        dbState.projectMemberRows.filter((r) => r.userId === userId).map((r) => r.projectId),
      );
      return allowed.size === 0
        ? { mode: 'none', allowed }
        : { mode: 'allow_only', allowed };
    },
    filterAccessibleProjectResources: async (_u: string, _a: string, _p: string, _t: string, ids: readonly string[]) => [...ids],
  };
});

mockIamMembershipSyncNoop();

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

mock.module('../projects/git', () => ({
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  createRemoteSessionBranch: async () => undefined,
  listRepoFiles: async (project: ProjectRow, ref: string, path?: string) => {
    listRepoFileCalls.push({ projectId: project.projectId, ref, path: path ?? null });
    return repoFiles;
  },
  loadProjectConfig: async (_project: ProjectRow, files: typeof repoFiles) => ({
    manifest: { project: { name: 'Existing Project' }, env: { required: ['DATABASE_URL'] } },
    env: { required: ['DATABASE_URL'], optional: [] },
    opencode: { agents: ['default'], skills: ['git-workflow'], files: files.map((file) => file.path) },
  }),
  readRepoFile: async (project: ProjectRow, path: string, ref: string) => {
    readRepoFileCalls.push({ projectId: project.projectId, path, ref });
    if (path === 'missing.txt') {
      throw new Error("fatal: path 'missing.txt' does not exist in 'feature'");
    }
    return `content:${path}@${ref}`;
  },
  readManifestFromRepo: async () => null,
  archiveRepoSubtree: async (project: ProjectRow, ref: string, path?: string | null) => {
    archiveCalls.push({ projectId: project.projectId, ref, path: path ?? null });
    // git archive --format=zip outputs binary; emit a tiny readable stream
    // so the route can pipe a real Response back to the test.
    const body = new TextEncoder().encode(`zip:${project.projectId}:${ref}:${path ?? ''}`);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  },
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  invalidateProjectMirror: () => {},
  resolveCommitSha: async () => 'a'.repeat(40),
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
  resolveTreeOid: async () => 'b'.repeat(40),
  materializeRepoContext: async () => '/tmp/fake-snapshot-context',
}));

mock.module("../snapshots/builder", () => ({
  ensureSandboxImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
  deleteSandboxImage: async () => ({ deleted: false, snapshotName: "kortix-default-test", slug: "default" }),
  listSnapshotBuilds: async () => [],
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: "default", spec: {}, isDefault: true }),
  reconcileStaleBuilds: async () => ({ checked: 0, updated: 0 }),
  ensurePlatformDefaultImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
  kickPreBuild: () => {},
  kickRoutedPreBuild: () => {},
  templateBuildProviders: () => ['daytona', 'platinum', 'e2b'],
  kickStartupPreBuild: () => {},
  reconcileProjectTemplates: async () => ({ checked: 0, updated: 0 }),
  kickProjectTemplatePrebuilds: () => {},
  resolveCommitSha: async () => "a".repeat(40),
  DEFAULT_SANDBOX_SLUG: "default",
}));

mock.module('../projects/github', () => ({
  parseGitHubRepoUrl: () => null,
  isOrgAccount: async () => false,
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  createGitHubAppJwt: () => 'jwt-test',
  verifyGitHubAppInstallState: (state: string) => state,
  verifyGitHubAppInstallStatePayload: (state: string) => ({
    accountId: state,
    nonce: 'test-nonce',
    issuedAt: Math.floor(Date.now() / 1000),
  }),
  getGitHubPatAuthContext: () => ({ token: 'pat-token', source: 'pat', owner: 'kortix-org' }),
  addCollaborator: async () => undefined,
  deleteFile: async () => undefined,
  deleteRepo: async () => undefined,
  commitFile: async (input: any) => {
    commitCalls.push(input);
  },
  getBranchCommitSha: async () => 'a'.repeat(40),
  createBranchRef: async () => undefined,
  createInstallationToken: async () => ({ token: 'installation-token' }),
  createRepo: async () => {
    throw new Error('create-repo route is covered separately');
  },
  getFileSha: async () => null,
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: {},
  }),
  getRepo: async () => ({
    id: 7,
    name: 'new-project',
    full_name: 'kortix-org/new-project',
    private: true,
    html_url: 'https://github.com/kortix-org/new-project',
    clone_url: 'https://github.com/kortix-org/new-project.git',
    ssh_url: 'git@github.com:kortix-org/new-project.git',
    default_branch: 'trunk',
    description: null,
  }),
  getRepositoryBranch: async ({ branch }: { branch: string }) => {
    if (branch === rejectedBranch) {
      throw Object.assign(new Error(`GitHub branch ${branch} not found`), { status: 404 });
    }
    return { name: branch, protected: false };
  },
  listInstallationRepositories: async () => [],
  listRepositoryBranches: async () => [],
  isGithubAppConfigured: () => false,
  isGithubPatConfigured: () => true,
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
        // A shadow principal (user_id == account_id) has no backing auth user:
        // a completed lookup returns no user object. Real users resolve normally.
        getUserById: async (uid: string) =>
          uid === ACCOUNT_ID
            ? { data: { user: null } }
            : { data: { user: { email: 'project@example.test' } } },
      },
    },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  upsertCreditAccount: async () => undefined,
  getSubscriptionInfo: async () => ({ tier: 'free' }),
  getCreditAccount: async () => null,
  getCreditBalance: async () => ({ balance: 0, granted: 0, used: 0 }),
  updateCreditAccount: async () => {},
}));

const projectDbMock = createProjectsContractDbMock(dbState);

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: projectDbMock,
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

describe('projects API contract', () => {
  beforeEach(() => resetState());

  test('registers a repo on its GitHub default without starter commits and grants manager access', async () => {
    const app = createApp();
    const missing = await app.request('/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'repo_url is required' });

    const res = await app.request('/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        repo_url: 'https://github.com/kortix-org/new-project.git/',
        name: 'New Project',
        manifest_path: 'config/kortix.yaml',
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      project_id: NEW_PROJECT_ID,
      account_id: ACCOUNT_ID,
      name: 'New Project',
      repo_url: 'https://github.com/kortix-org/new-project.git',
      default_branch: 'trunk',
      manifest_path: 'config/kortix.yaml',
      status: 'active',
      project_role: 'manager',
      effective_project_role: 'manager',
    });
    expect(commitCalls).toHaveLength(0);
    expect(dbState.gitConnectionRows).toContainEqual(expect.objectContaining({
      projectId: NEW_PROJECT_ID,
      provider: 'github',
      repoUrl: 'https://github.com/kortix-org/new-project.git',
      repoOwner: 'kortix-org',
      repoName: 'new-project',
      externalRepoId: '7',
      authMethod: 'github_app',
      installationId: '42',
      visibility: 'private',
      status: 'connected',
    }));
    expect(dbState.projectMemberRows).toContainEqual(expect.objectContaining({
      projectId: NEW_PROJECT_ID,
      userId: OWNER_ID,
      projectRole: 'manager',
    }));
  });

  test('creates independent projects for different branches of one repository', async () => {
    const app = createApp();
    const payload = {
      account_id: ACCOUNT_ID,
      repo_url: 'https://github.com/kortix-org/new-project.git',
    };
    const request = (name: string, defaultBranch: string) => app.request('/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, name, default_branch: defaultBranch }),
    });

    const first = await request('Production', 'main');
    const second = await request('Development', 'dev');
    expect([first.status, second.status]).toEqual([201, 201]);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    expect([firstBody.project_id, secondBody.project_id]).toEqual([
      NEW_PROJECT_ID,
      SECOND_NEW_PROJECT_ID,
    ]);
    expect(dbState.projectRows.filter((row) => row.repoUrl === payload.repo_url)).toEqual([
      expect.objectContaining({
        projectId: NEW_PROJECT_ID,
        name: 'Production',
        defaultBranch: 'main',
      }),
      expect.objectContaining({
        projectId: SECOND_NEW_PROJECT_ID,
        name: 'Development',
        defaultBranch: 'dev',
      }),
    ]);
    expect(dbState.gitConnectionRows.map((row) => [row.projectId, row.defaultBranch])).toEqual([
      [NEW_PROJECT_ID, 'main'],
      [SECOND_NEW_PROJECT_ID, 'dev'],
    ]);
  });

  test('rejects a branch GitHub cannot resolve before inserting the project', async () => {
    rejectedBranch = 'missing-branch';
    const res = await createApp().request('/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        repo_url: 'https://github.com/kortix-org/new-project.git',
        default_branch: rejectedBranch,
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Selected branch "missing-branch" does not exist in kortix-org/new-project',
    });
    expect(dbState.projectRows.some((row) => row.defaultBranch === rejectedBranch)).toBe(false);
  });

  test('lists all active projects for account managers and only explicit grants for members', async () => {
    const app = createApp();
    let res = await app.request(`/v1/projects?account_id=${ACCOUNT_ID}`);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.map((project: any) => project.project_id).sort()).toEqual([PROJECT_ID, OTHER_PROJECT_ID]);
    expect(body.every((project: any) => project.effective_project_role === 'manager')).toBe(true);

    dbState.projectMemberRows.push({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      projectRole: 'member',
      grantedBy: OWNER_ID,
      createdAt: baseDate,
      updatedAt: baseDate,
    });
    setCurrentUser(MEMBER_ID, 'member@example.test');

    res = await app.request(`/v1/projects?account_id=${ACCOUNT_ID}`);
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      project_id: PROJECT_ID,
      project_role: 'member',
      effective_project_role: 'member',
    });
  });

  test('returns detail, file listings, file content, and updates last_opened_at', async () => {
    const app = createApp();
    const detail = await app.request(`/v1/projects/${PROJECT_ID}/detail`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      project: { project_id: PROJECT_ID, effective_project_role: 'manager' },
      config: {
        manifest: { project: { name: 'Existing Project' } },
        opencode: { agents: ['default'], skills: ['git-workflow'] },
      },
      file_count: repoFiles.length,
    });
    expect(listRepoFileCalls[0]).toEqual({ projectId: PROJECT_ID, ref: 'main', path: null });

    const files = await app.request(`/v1/projects/${PROJECT_ID}/files?ref=dev&path=.opencode`);
    expect(files.status).toBe(200);
    expect(await files.json()).toEqual(repoFiles);
    expect(listRepoFileCalls.at(-1)).toEqual({ projectId: PROJECT_ID, ref: 'dev', path: '.opencode' });

    const missingPath = await app.request(`/v1/projects/${PROJECT_ID}/files/content`);
    expect(missingPath.status).toBe(400);
    expect(await missingPath.json()).toEqual({ error: 'path query param is required' });

    const content = await app.request(`/v1/projects/${PROJECT_ID}/files/content?path=README.md&ref=feature`);
    expect(content.status).toBe(200);
    expect(await content.json()).toEqual({
      path: 'README.md',
      ref: 'feature',
      content: 'content:README.md@feature',
    });
    expect(readRepoFileCalls.at(-1)).toEqual({ projectId: PROJECT_ID, path: 'README.md', ref: 'feature' });

    const missingFile = await app.request(`/v1/projects/${PROJECT_ID}/files/content?path=missing.txt&ref=feature`);
    expect(missingFile.status).toBe(404);
    expect(await missingFile.json()).toEqual({ error: 'File not found' });
    expect(readRepoFileCalls.at(-1)).toEqual({ projectId: PROJECT_ID, path: 'missing.txt', ref: 'feature' });

    const read = await app.request(`/v1/projects/${PROJECT_ID}`);
    expect(read.status).toBe(200);
    expect(dbState.projectRows.find((project) => project.projectId === PROJECT_ID)?.lastOpenedAt).toBeInstanceOf(Date);
  });

  test('streams a zip archive of the repo / subtree', async () => {
    const app = createApp();

    // No path → archives the whole tree at the default branch.
    const root = await app.request(`/v1/projects/${PROJECT_ID}/files/archive`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('application/zip');
    expect(root.headers.get('content-disposition')).toBe('attachment; filename="workspace.zip"');
    expect(await root.text()).toBe(`zip:${PROJECT_ID}:main:`);
    expect(archiveCalls.at(-1)).toEqual({ projectId: PROJECT_ID, ref: 'main', path: null });

    // ref + subtree path → archives just that subtree, filename derived from path.
    const subtree = await app.request(
      `/v1/projects/${PROJECT_ID}/files/archive?ref=dev&path=.kortix/opencode/agents`,
    );
    expect(subtree.status).toBe(200);
    expect(subtree.headers.get('content-type')).toBe('application/zip');
    expect(subtree.headers.get('content-disposition')).toBe('attachment; filename="agents.zip"');
    expect(await subtree.text()).toBe(`zip:${PROJECT_ID}:dev:.kortix/opencode/agents`);
    expect(archiveCalls.at(-1)).toEqual({
      projectId: PROJECT_ID,
      ref: 'dev',
      path: '.kortix/opencode/agents',
    });

    // Absolute / workspace-prefixed paths are rejected (the UI must strip them).
    // archiveRepoSubtree throws via normalizeTreePath; route surfaces a 400.
    mock.module('../projects/git', () => ({
      createRemoteSessionBranch: async () => undefined,
      listRepoFiles: async () => repoFiles,
      loadProjectConfig: async () => ({ manifest: {}, env: { required: [], optional: [] }, opencode: {} }),
      readRepoFile: async () => '',
      readManifestFromRepo: async () => null,
      archiveRepoSubtree: async (_p: any, _r: string, path?: string | null) => {
        if (path && path.startsWith('/')) throw new Error('Invalid path');
        const body = new TextEncoder().encode('ok');
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        });
      },
      listBranches: async () => [],
      listCommits: async () => ({ entries: [], nextCursor: null }),
      getCommit: async () => null,
      getCommitDiff: async () => null,
      getFileHistory: async () => ({ entries: [], nextCursor: null }),
      invalidateProjectMirror: () => {},
    }));

    const bad = await app.request(`/v1/projects/${PROJECT_ID}/files/archive?path=%2Fworkspace`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid path' });
  });

  test('archive endpoint denies users without read access', async () => {
    const app = createApp();
    setCurrentUser(OUTSIDER_ID, 'outsider@example.test');
    const res = await app.request(`/v1/projects/${PROJECT_ID}/files/archive`);
    expect(res.status).toBe(403);
  });

  test('patches only project config fields and archives projects', async () => {
    const app = createApp();
    const beforeRepoUrl = dbState.projectRows.find((project) => project.projectId === PROJECT_ID)!.repoUrl;
    const patch = await app.request(`/v1/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed Project',
        default_branch: 'release',
        manifest_path: 'ops/kortix.yaml',
        repo_url: 'https://github.com/kortix/should-not-change.git',
      }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      project_id: PROJECT_ID,
      name: 'Renamed Project',
      default_branch: 'release',
      manifest_path: 'ops/kortix.yaml',
      repo_url: beforeRepoUrl,
    });

    const del = await app.request(`/v1/projects/${PROJECT_ID}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(dbState.projectRows.find((project) => project.projectId === PROJECT_ID)?.status).toBe('archived');

    const after = await app.request(`/v1/projects/${PROJECT_ID}`);
    expect(after.status).toBe(404);
  });

  test('lists and manages explicit project access grants without overriding account managers', async () => {
    const app = createApp();

    let access = await app.request(`/v1/projects/${PROJECT_ID}/access`);
    expect(access.status).toBe(200);
    let body = await access.json();
    expect(body).toMatchObject({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      can_manage: true,
      viewer_user_id: OWNER_ID,
    });
    expect(body.members.map((member: any) => ({
      user_id: member.user_id,
      account_role: member.account_role,
      project_role: member.project_role,
      effective_project_role: member.effective_project_role,
      has_implicit_access: member.has_implicit_access,
    }))).toEqual([
      {
        user_id: OWNER_ID,
        account_role: 'owner',
        project_role: null,
        effective_project_role: 'manager',
        has_implicit_access: true,
      },
      {
        user_id: MEMBER_ID,
        account_role: 'member',
        project_role: null,
        effective_project_role: null,
        has_implicit_access: false,
      },
    ]);

    const grant = await app.request(`/v1/projects/${PROJECT_ID}/access/${MEMBER_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(grant.status).toBe(200);
    expect(await grant.json()).toMatchObject({
      user_id: MEMBER_ID,
      account_role: 'member',
      project_role: 'editor',
      effective_project_role: 'editor',
      has_implicit_access: false,
    });
    expect(dbState.projectMemberRows).toContainEqual(expect.objectContaining({
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      projectRole: 'editor',
    }));

    access = await app.request(`/v1/projects/${PROJECT_ID}/access`);
    body = await access.json();
    const memberRow = body.members.find((member: any) => member.user_id === MEMBER_ID);
    expect(memberRow).toMatchObject({
      project_role: 'editor',
      effective_project_role: 'editor',
      has_implicit_access: false,
    });

    const ownerGrant = await app.request(`/v1/projects/${PROJECT_ID}/access/${OWNER_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });
    expect(ownerGrant.status).toBe(200);
    expect(await ownerGrant.json()).toMatchObject({
      user_id: OWNER_ID,
      account_role: 'owner',
      project_role: null,
      effective_project_role: 'manager',
      has_implicit_access: true,
    });

    const removeOwner = await app.request(`/v1/projects/${PROJECT_ID}/access/${OWNER_ID}`, {
      method: 'DELETE',
    });
    expect(removeOwner.status).toBe(409);

    const removeMember = await app.request(`/v1/projects/${PROJECT_ID}/access/${MEMBER_ID}`, {
      method: 'DELETE',
    });
    expect(removeMember.status).toBe(200);
    expect(await removeMember.json()).toEqual({ ok: true });
    expect(dbState.projectMemberRows.some((row) => row.userId === MEMBER_ID && row.projectId === PROJECT_ID)).toBe(false);
  });

  test('GET /access drops shadow members whose user_id is not a real auth user', async () => {
    // Regression: a self-referential account_members row (user_id == account_id)
    // with no backing auth user used to surface as a bare UUID in the access list
    // (the email never resolves, so the UI fell back to the raw id).
    dbState.accountMemberRows.push({
      userId: ACCOUNT_ID,
      accountId: ACCOUNT_ID,
      accountRole: 'owner',
      joinedAt: baseDate,
    });
    const app = createApp();
    const access = await app.request(`/v1/projects/${PROJECT_ID}/access`);
    expect(access.status).toBe(200);
    const body = await access.json();
    const ids = body.members.map((m: any) => m.user_id);
    expect(ids).not.toContain(ACCOUNT_ID); // shadow principal filtered out
    expect(ids).toContain(OWNER_ID); // real owner kept
    expect(ids).toContain(MEMBER_ID); // real member kept
  });

  test('denies non-members and plain project users from manager-only operations', async () => {
    const app = createApp();
    setCurrentUser(OUTSIDER_ID, 'outsider@example.test');
    const outsider = await app.request(`/v1/projects/${PROJECT_ID}/files`);
    expect(outsider.status).toBe(403);

    setCurrentUser(MEMBER_ID, 'member@example.test');
    dbState.projectMemberRows.push({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      projectRole: 'member',
      grantedBy: OWNER_ID,
      createdAt: baseDate,
      updatedAt: baseDate,
    });
    const userPatch = await app.request(`/v1/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User Rename' }),
    });
    expect(userPatch.status).toBe(403);
  });
});
