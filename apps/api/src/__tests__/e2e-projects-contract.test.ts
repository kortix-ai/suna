import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, projectMembers, projects } from '@kortix/db';

const OWNER_ID = '00000000-0000-4000-a000-000000000001';
const MEMBER_ID = '00000000-0000-4000-a000-000000000002';
const OUTSIDER_ID = '00000000-0000-4000-a000-000000000003';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const OTHER_PROJECT_ID = '00000000-0000-4000-a000-000000000202';
const NEW_PROJECT_ID = '00000000-0000-4000-a000-000000000203';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

type AccountRole = 'owner' | 'admin' | 'member';
type ProjectRole = 'manager' | 'editor' | 'viewer';

interface ProjectRow {
  projectId: string;
  accountId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string;
  status: 'active' | 'archived';
  metadata: Record<string, unknown>;
  lastOpenedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AccountMemberRow {
  userId: string;
  accountId: string;
  accountRole: AccountRole;
  joinedAt: Date;
}

interface ProjectMemberRow {
  accountId: string;
  projectId: string;
  userId: string;
  projectRole: ProjectRole;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const baseDate = new Date('2026-01-01T00:00:00Z');
const repoFiles = [
  { path: 'README.md', type: 'file', size: 18 },
  { path: 'kortix.toml', type: 'file', size: 42 },
  { path: '.opencode/opencode.jsonc', type: 'file', size: 90 },
  { path: '.opencode/agents/default.md', type: 'file', size: 120 },
];

let currentUserId: string;
let currentUserEmail: string;
let accountMemberRows: AccountMemberRow[];
let projectRows: ProjectRow[];
let projectMemberRows: ProjectMemberRow[];
let nextProjectId: string;
let commitCalls: any[];
let listRepoFileCalls: any[];
let readRepoFileCalls: any[];
let archiveCalls: any[];

function setCurrentUser(userId: string, userEmail: string) {
  currentUserId = userId;
  currentUserEmail = userEmail;
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}

function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: currentUserId, userEmail: currentUserEmail };
}

function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Existing Project',
    repoUrl: 'https://github.com/kortix/existing-project.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.toml',
    status: 'active',
    metadata: {},
    lastOpenedAt: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    ...overrides,
  };
}

function resetState() {
  setCurrentUser(OWNER_ID, 'owner@example.test');
  accountMemberRows = [
    { userId: OWNER_ID, accountId: ACCOUNT_ID, accountRole: 'owner', joinedAt: baseDate },
    { userId: MEMBER_ID, accountId: ACCOUNT_ID, accountRole: 'member', joinedAt: baseDate },
  ];
  projectRows = [
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
  projectMemberRows = [];
  nextProjectId = NEW_PROJECT_ID;
  commitCalls = [];
  listRepoFileCalls = [];
  readRepoFileCalls = [];
  archiveCalls = [];
}

function collectConditionValues(condition: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const visit = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node.queryChunks) visit(node.queryChunks);
    if (Object.prototype.hasOwnProperty.call(node, 'value') && node.encoder?.name && !Array.isArray(node.value)) {
      values[node.encoder.name] = node.value;
    }
  };
  visit(condition);
  return values;
}

function queryResult<T = any>(rows: T[]) {
  return {
    then: (resolve: (value: T[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async (count: number) => rows.slice(0, count),
    orderBy: async () => rows,
  };
}

function selectRows(table: unknown, fields: Record<string, unknown> | undefined, condition: unknown): any[] {
  const values = collectConditionValues(condition);
  const accountId = values.account_id as string | undefined;
  const userId = values.user_id as string | undefined;
  const projectId = values.project_id as string | undefined;
  const status = values.status as string | undefined;

  if (table === accountMembers) {
    return accountMemberRows
      .filter((row) =>
        (!accountId || row.accountId === accountId) &&
        (!userId || row.userId === userId)
      );
  }

  if (table === projectMembers) {
    return projectMemberRows
      .filter((row) =>
        (!accountId || row.accountId === accountId) &&
        (!projectId || row.projectId === projectId) &&
        (!userId || row.userId === userId)
      );
  }

  if (table === projects) {
    const inArrayProjectIds = extractStringArray(condition);
    return projectRows.filter((row) =>
      (!accountId || row.accountId === accountId) &&
      (!projectId || row.projectId === projectId) &&
      (!status || row.status === status) &&
      (!inArrayProjectIds || inArrayProjectIds.includes(row.projectId))
    );
  }

  return [];
}

function extractStringArray(condition: unknown): string[] | null {
  let result: string[] | null = null;
  const visit = (node: any) => {
    if (!node || result) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node.queryChunks) visit(node.queryChunks);
    if (Array.isArray(node.value) && node.encoder?.name && node.value.every((item: unknown) => typeof item === 'string')) {
      result = node.value;
    }
  };
  visit(condition);
  return result;
}

function upsertProject(values: any, set?: Partial<ProjectRow>) {
  const existing = projectRows.find((row) => row.accountId === values.accountId && row.repoUrl === values.repoUrl);
  if (existing) {
    Object.assign(existing, set ?? values);
    return existing;
  }
  const row: ProjectRow = {
    projectId: nextProjectId,
    accountId: values.accountId,
    name: values.name,
    repoUrl: values.repoUrl,
    defaultBranch: values.defaultBranch ?? 'main',
    manifestPath: values.manifestPath ?? 'kortix.toml',
    status: values.status ?? 'active',
    metadata: values.metadata ?? {},
    lastOpenedAt: null,
    createdAt: baseDate,
    updatedAt: values.updatedAt ?? baseDate,
  };
  projectRows.push(row);
  return row;
}

function grantProjectRole(values: any, set?: Partial<ProjectMemberRow>) {
  const existing = projectMemberRows.find((row) => row.projectId === values.projectId && row.userId === values.userId);
  if (existing) {
    Object.assign(existing, set ?? values);
    return existing;
  }
  const row: ProjectMemberRow = {
    accountId: values.accountId,
    projectId: values.projectId,
    userId: values.userId,
    projectRole: values.projectRole,
    grantedBy: values.grantedBy ?? null,
    createdAt: baseDate,
    updatedAt: values.updatedAt ?? baseDate,
  };
  projectMemberRows.push(row);
  return row;
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
    return `content:${path}@${ref}`;
  },
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
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  deleteFile: async () => undefined,
  commitFile: async (input: any) => {
    commitCalls.push(input);
  },
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
        getUserById: async () => ({ data: { user: { email: 'project@example.test' } } }),
      },
    },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'free' }),
}));

mock.module('../shared/db', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => queryResult(selectRows(table, fields, condition)),
        orderBy: async () => selectRows(table, fields, undefined),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoUpdate: ({ set }: { set?: Record<string, unknown> }) => ({
          returning: async () => {
            if (table === projects) return [upsertProject(values, set as Partial<ProjectRow>)];
            return [];
          },
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => {
            if (table === projectMembers) {
              return Promise.resolve([grantProjectRole(values, set as Partial<ProjectMemberRow>)]).then(resolve, reject);
            }
            return Promise.resolve([]).then(resolve, reject);
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Partial<ProjectRow>) => ({
        where: (condition: unknown) => {
          const update = async () => {
            const values = collectConditionValues(condition);
            if (table !== projects) return [];
            const row = projectRows.find((project) => project.projectId === values.project_id);
            if (!row) return [];
            Object.assign(row, updates);
            return [row];
          };
          return {
            returning: update,
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
              update().then(resolve, reject),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        const values = collectConditionValues(condition);
        if (table === projectMembers) {
          projectMemberRows = projectMemberRows.filter((row) =>
            !(
              (!values.project_id || row.projectId === values.project_id) &&
              (!values.user_id || row.userId === values.user_id)
            )
          );
        }
      },
    }),
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

describe('projects API contract', () => {
  beforeEach(() => resetState());

  test('registers an existing repo without starter commits and grants manager access', async () => {
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
        repo_url: 'https://github.com/kortix/new-project.git/',
        name: 'New Project',
        default_branch: 'trunk',
        manifest_path: 'config/kortix.toml',
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      project_id: NEW_PROJECT_ID,
      account_id: ACCOUNT_ID,
      name: 'New Project',
      repo_url: 'https://github.com/kortix/new-project.git',
      default_branch: 'trunk',
      manifest_path: 'config/kortix.toml',
      status: 'active',
      project_role: 'manager',
      effective_project_role: 'manager',
    });
    expect(commitCalls).toHaveLength(0);
    expect(projectMemberRows).toContainEqual(expect.objectContaining({
      projectId: NEW_PROJECT_ID,
      userId: OWNER_ID,
      projectRole: 'manager',
    }));
  });

  test('lists all active projects for account managers and only explicit grants for members', async () => {
    const app = createApp();
    let res = await app.request(`/v1/projects?account_id=${ACCOUNT_ID}`);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.map((project: any) => project.project_id).sort()).toEqual([PROJECT_ID, OTHER_PROJECT_ID]);
    expect(body.every((project: any) => project.effective_project_role === 'manager')).toBe(true);

    projectMemberRows.push({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      projectRole: 'viewer',
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
      project_role: 'viewer',
      effective_project_role: 'viewer',
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

    const read = await app.request(`/v1/projects/${PROJECT_ID}`);
    expect(read.status).toBe(200);
    expect(projectRows.find((project) => project.projectId === PROJECT_ID)?.lastOpenedAt).toBeInstanceOf(Date);
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
      `/v1/projects/${PROJECT_ID}/files/archive?ref=dev&path=.opencode/agents`,
    );
    expect(subtree.status).toBe(200);
    expect(subtree.headers.get('content-type')).toBe('application/zip');
    expect(subtree.headers.get('content-disposition')).toBe('attachment; filename="agents.zip"');
    expect(await subtree.text()).toBe(`zip:${PROJECT_ID}:dev:.opencode/agents`);
    expect(archiveCalls.at(-1)).toEqual({
      projectId: PROJECT_ID,
      ref: 'dev',
      path: '.opencode/agents',
    });

    // Absolute / workspace-prefixed paths are rejected (the UI must strip them).
    // archiveRepoSubtree throws via normalizeTreePath; route surfaces a 400.
    mock.module('../projects/git', () => ({
      createRemoteSessionBranch: async () => undefined,
      listRepoFiles: async () => repoFiles,
      loadProjectConfig: async () => ({ manifest: {}, env: { required: [], optional: [] }, opencode: {} }),
      readRepoFile: async () => '',
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
    const beforeRepoUrl = projectRows.find((project) => project.projectId === PROJECT_ID)!.repoUrl;
    const patch = await app.request(`/v1/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed Project',
        default_branch: 'release',
        manifest_path: 'ops/kortix.toml',
        repo_url: 'https://github.com/kortix/should-not-change.git',
      }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      project_id: PROJECT_ID,
      name: 'Renamed Project',
      default_branch: 'release',
      manifest_path: 'ops/kortix.toml',
      repo_url: beforeRepoUrl,
    });

    const del = await app.request(`/v1/projects/${PROJECT_ID}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(projectRows.find((project) => project.projectId === PROJECT_ID)?.status).toBe('archived');

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
    expect(projectMemberRows).toContainEqual(expect.objectContaining({
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
      body: JSON.stringify({ role: 'viewer' }),
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
    expect(projectMemberRows.some((row) => row.userId === MEMBER_ID && row.projectId === PROJECT_ID)).toBe(false);
  });

  test('denies non-members and project viewers from manager-only operations', async () => {
    const app = createApp();
    setCurrentUser(OUTSIDER_ID, 'outsider@example.test');
    const outsider = await app.request(`/v1/projects/${PROJECT_ID}/files`);
    expect(outsider.status).toBe(403);

    setCurrentUser(MEMBER_ID, 'member@example.test');
    projectMemberRows.push({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      projectRole: 'viewer',
      grantedBy: OWNER_ID,
      createdAt: baseDate,
      updatedAt: baseDate,
    });
    const viewerPatch = await app.request(`/v1/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Viewer Rename' }),
    });
    expect(viewerPatch.status).toBe(403);
  });
});
