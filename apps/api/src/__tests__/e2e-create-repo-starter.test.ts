import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountGithubInstallations,
  accountGithubInstallationStates,
  accountMembers,
  projectGitConnections,
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
// The minimal starter == the shared `templates/base` tree (no general-knowledge
// -worker skill pack). Ordered by `path.localeCompare` to match getStarterFiles'
// stable sort. Regenerate from `packages/starter/templates/base` when the base
// scaffold changes.
const BASE_STARTER_PATHS = [
  '.gitignore',
  '.kortix/memory/conventions.md',
  '.kortix/memory/decisions.md',
  '.kortix/memory/integrations.md',
  '.kortix/memory/MEMORY.md',
  '.kortix/memory/overview.md',
  '.kortix/opencode/agents/kortix.md',
  '.kortix/opencode/agents/memory-reflector.md',
  '.kortix/opencode/bun.lock',
  '.kortix/opencode/opencode.jsonc',
  '.kortix/opencode/package.json',
  '.kortix/opencode/plugins/kortix-simple-memory.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/constants.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/buffer.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/formatters.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/manager.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/permissions.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/session-lifecycle.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/types.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/wildcard.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/types.ts',
  '.kortix/opencode/pty/opencode-pty/src/shared/constants.ts',
  '.kortix/opencode/pty/pty-tools.ts',
  '.kortix/opencode/skills/agent-browser/SKILL.md',
  '.kortix/opencode/skills/kortix-executor/SKILL.md',
  '.kortix/opencode/skills/kortix-memory/SKILL.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/change-requests.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/kortix-toml.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/agents.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/commands.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/mcp-servers.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/models.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/overview.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/permissions.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/plugins.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/rules.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/skills.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/tools.md',
  '.kortix/opencode/skills/kortix-system/SKILL.md',
  '.kortix/opencode/skills/slack/SKILL.md',
  '.kortix/opencode/tools/image_search.ts',
  '.kortix/opencode/tools/lib/get-env.ts',
  '.kortix/opencode/tools/memory.ts',
  '.kortix/opencode/tools/scrape_webpage.ts',
  '.kortix/opencode/tools/show.ts',
  '.kortix/opencode/tools/web_search.ts',
  'app/index.js',
  'app/package.json',
  'kortix.toml',
  'README.md',
];

let repoCreateCalls: any[];
let fileShaCalls: any[];
let commitCalls: any[];
let insertedProject: any | null;
let grantedProjectRole: any | null;
let installationRows: Array<typeof accountGithubInstallations.$inferSelect>;
let gitConnectionRows: Array<typeof projectGitConnections.$inferSelect>;
let githubInstallationStateConsumed: boolean;

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
  gitConnectionRows = [];
  githubInstallationStateConsumed = false;
  installationRows = [{
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

mockIamEngineAllowAll();

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
  // Used by snapshots/builder + the snapshots HTTP surface in projects/index.
  resolveCommitSha: async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  resolveTreeOid: async () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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

// snapshots/builder imports from projects/git — once mocked, builder.ts
// resolves cleanly. We stub the helpers projects/index calls so the
// fire-and-forget snapshot kickoff in the create paths is a no-op here.
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

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  verifyGitHubAppInstallState: (state: string) => state === 'valid-install-state' ? ACCOUNT_ID : null,
  verifyGitHubAppInstallStatePayload: (state: string) => state === 'valid-install-state'
    ? { accountId: ACCOUNT_ID, nonce: 'valid-install-nonce', issuedAt: Math.floor(Date.now() / 1000) }
    : null,
  deleteFile: async () => undefined,
  commitFile: async (input: any) => {
    commitCalls.push(input);
  },
  createInstallationToken: async (installationId: string) => {
    expect(['42', '84']).toContain(installationId);
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
  deleteRepo: async () => undefined,
  addCollaborator: async () => undefined,
  getBranchCommitSha: async () => 'a'.repeat(40),
  createBranchRef: async () => undefined,
  parseGitHubRepoUrl: (repoUrl: string) => {
    const match = repoUrl.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?$/);
    return match?.groups ? { owner: match.groups.owner, repo: match.groups.repo } : null;
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
  getRepo: async (input: any) => ({
    id: input.owner === 'acme' ? 84 : 7,
    name: input.repo,
    full_name: `${input.owner}/${input.repo}`,
    private: true,
    html_url: `https://github.com/${input.owner}/${input.repo}`,
    clone_url: `https://github.com/${input.owner}/${input.repo}.git`,
    ssh_url: `git@github.com:${input.owner}/${input.repo}.git`,
    default_branch: input.owner === 'acme' ? 'trunk' : 'main',
    description: null,
  }),
  listInstallationRepositories: async (installationId: string) => installationId === '84'
    ? [{
        id: 84,
        name: 'portal',
        full_name: 'acme/portal',
        private: true,
        html_url: 'https://github.com/acme/portal',
        clone_url: 'https://github.com/acme/portal.git',
        ssh_url: 'git@github.com:acme/portal.git',
        default_branch: 'trunk',
        description: null,
      }]
    : [],
  isGithubAppConfigured: () => true,
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
  getSubscriptionInfo: async () => ({ tier: 'pro' }),
  // Billing-active account so any session spawned during the flow clears the gate.
  getCreditAccount: async () => ({
    balance: 1_000_000,
    billingModel: 'credits',
    stripeSubscriptionId: 'sub_test',
    stripeSubscriptionStatus: 'active',
  }),
  getCreditBalance: async () => ({ balance: 1_000_000, granted: 1_000_000, used: 0 }),
  updateCreditAccount: async () => {},
}));

async function selectRowsForTable(table: unknown) {
  if (table === accountMembers) {
    return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
  }
  if (table === accountGithubInstallations) {
    return installationRows;
  }
  if (table === accountGithubInstallationStates) {
    return githubInstallationStateConsumed
      ? [{
          installationId: '42',
          consumedAt: new Date('2026-01-01T00:00:00Z'),
        }]
      : [];
  }
  if (table === projectGitConnections) {
    return gitConnectionRows;
  }
  return [];
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const builder = {
            limit: async () => (await selectRowsForTable(table)).slice(0, 1),
            orderBy: () => ({
              limit: async () => (await selectRowsForTable(table)).slice(0, 1),
              then: (resolve: any, reject: any) =>
                selectRowsForTable(table).then(resolve, reject),
            }),
            then: (resolve: any, reject: any) =>
              selectRowsForTable(table).then(resolve, reject),
          };
          return builder;
        },
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
                const existingIndex = installationRows.findIndex((row) =>
                  row.accountId === values.accountId &&
                  row.installationId === values.installationId,
                );
                const row = {
                  installationRowId: existingIndex >= 0
                    ? installationRows[existingIndex]!.installationRowId
                    : '00000000-0000-4000-a000-000000000042',
                  accountId: values.accountId,
                  installationId: values.installationId,
                  ownerLogin: values.ownerLogin,
                  ownerType: values.ownerType,
                  repositorySelection: values.repositorySelection ?? null,
                  permissions: values.permissions ?? {},
                  metadata: values.metadata ?? {},
                  createdAt: existingIndex >= 0
                    ? installationRows[existingIndex]!.createdAt
                    : new Date('2026-01-01T00:00:00Z'),
                  updatedAt: values.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
                };
                if (existingIndex >= 0) installationRows[existingIndex] = row;
                else installationRows.push(row);
                return [row];
              }
              if (table === projectGitConnections) {
                const existingIndex = gitConnectionRows.findIndex((row) => row.projectId === values.projectId);
                const row = {
                  connectionId: existingIndex >= 0
                    ? gitConnectionRows[existingIndex]!.connectionId
                    : '00000000-0000-4000-a000-000000000501',
                  accountId: values.accountId,
                  projectId: values.projectId,
                  provider: values.provider,
                  repoUrl: values.repoUrl,
                  repoOwner: values.repoOwner ?? null,
                  repoName: values.repoName ?? null,
                  externalRepoId: values.externalRepoId ?? null,
                  defaultBranch: values.defaultBranch,
                  authMethod: values.authMethod,
                  installationId: values.installationId ?? null,
                  credentialRef: values.credentialRef ?? null,
                  permissions: values.permissions ?? {},
                  visibility: values.visibility ?? null,
                  webhookId: values.webhookId ?? null,
                  status: values.status ?? 'connected',
                  lastValidatedAt: values.lastValidatedAt ?? new Date('2026-01-01T00:00:00Z'),
                  lastErrorCode: values.lastErrorCode ?? null,
                  lastErrorMessage: values.lastErrorMessage ?? null,
                  metadata: values.metadata ?? {},
                  createdAt: existingIndex >= 0 ? gitConnectionRows[existingIndex]!.createdAt : new Date('2026-01-01T00:00:00Z'),
                  updatedAt: values.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
                } as typeof projectGitConnections.$inferSelect;
                if (existingIndex >= 0) gitConnectionRows[existingIndex] = row;
                else gitConnectionRows.push(row);
                return [row];
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
    update: (table: unknown) => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            if (table === accountGithubInstallationStates && !githubInstallationStateConsumed) {
              githubInstallationStateConsumed = true;
              return [{ stateNonce: 'valid-install-nonce' }];
            }
            return [];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === accountGithubInstallations) installationRows = [];
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

  test('builds exactly the minimal starter scaffold', () => {
    const files = buildStarterFiles({
      projectName: 'Company OS',
      repoFullName: 'kortix-org/company-os',
      template: 'minimal',
    });

    expect(files.map((file) => file.path)).toEqual(BASE_STARTER_PATHS);
    expect(new Set(files.map((file) => file.path)).size).toBe(BASE_STARTER_PATHS.length);
    expect(files.every((file) => file.content.trim().length > 0)).toBe(true);

    const agent = files.find((file) => file.path === '.kortix/opencode/agents/kortix.md');
    expect(agent?.content).toContain('permission:\n  "*": allow');
  });

  test('defaults to the general knowledge worker starter scaffold', () => {
    const files = buildStarterFiles({
      projectName: 'Company OS',
      repoFullName: 'kortix-org/company-os',
    });
    const paths = files.map((file) => file.path);

    for (const path of BASE_STARTER_PATHS) expect(paths).toContain(path);
    expect(paths).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/account-research/SKILL.md');
    expect(paths).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/audit-support/SKILL.md');
    expect(paths).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/content-creation/SKILL.md');
    expect(paths).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/brand-voice/SKILL.md');
    expect(new Set(paths).size).toBe(paths.length);
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
      installation_id: '42',
      owner_login: 'kortix-org',
      owner_type: 'Organization',
    });

    const upsert = await app.request('/v1/projects/github/installation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: 'valid-install-state',
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

    const replay = await app.request('/v1/projects/github/installation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: 'valid-install-state',
        installation_id: '42',
      }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      installed: true,
      installation_id: '42',
      owner_login: 'kortix-org',
    });

    const disconnect = await app.request(`/v1/projects/github/installation?account_id=${ACCOUNT_ID}`, {
      method: 'DELETE',
    });
    expect(disconnect.status).toBe(200);
    expect(await disconnect.json()).toEqual({ ok: true });
    expect(installationRows).toEqual([]);

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

  test('lists multiple GitHub installations and imports from the selected one', async () => {
    installationRows.push({
      installationRowId: '00000000-0000-4000-a000-000000000084',
      accountId: ACCOUNT_ID,
      installationId: '84',
      ownerLogin: 'acme',
      ownerType: 'Organization',
      repositorySelection: 'selected',
      permissions: { contents: 'write' },
      metadata: { html_url: 'https://github.com/organizations/acme/settings/installations/84' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });

    const app = createApp();
    const installations = await app.request(`/v1/projects/github/installations?account_id=${ACCOUNT_ID}`);
    expect(installations.status).toBe(200);
    const installationsBody = await installations.json();
    expect(installationsBody).toMatchObject({
      account_id: ACCOUNT_ID,
      installed: true,
    });
    expect(installationsBody.installations).toEqual(expect.arrayContaining([
      expect.objectContaining({ installation_id: '42', owner_login: 'kortix-org' }),
      expect.objectContaining({ installation_id: '84', owner_login: 'acme' }),
    ]));

    const repos = await app.request(
      `/v1/projects/github/repositories?account_id=${ACCOUNT_ID}&installation_id=84`,
    );
    expect(repos.status).toBe(200);
    expect(await repos.json()).toMatchObject({
      account_id: ACCOUNT_ID,
      installation_id: '84',
      owner_login: 'acme',
      repositories: [{ full_name: 'acme/portal', default_branch: 'trunk' }],
    });

    const linked = await app.request('/v1/projects/link-repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        installation_id: '84',
        repo_full_name: 'acme/portal',
      }),
    });
    expect(linked.status).toBe(201);
    expect(await linked.json()).toMatchObject({
      project: {
        repo_url: 'https://github.com/acme/portal.git',
        default_branch: 'trunk',
      },
      git_connection: {
        provider: 'github',
        repo_owner: 'acme',
        repo_name: 'portal',
        installation_id: '84',
      },
    });
  });

  test('commits the default starter scaffold with the account GitHub App token before registering the project', async () => {
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

    const committedPaths = commitCalls.map((call) => call.path);
    for (const path of BASE_STARTER_PATHS) expect(committedPaths).toContain(path);
    expect(committedPaths).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/account-research/SKILL.md');
    expect(committedPaths).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/audit-support/SKILL.md');
    expect(committedPaths).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/content-creation/SKILL.md');
    expect(commitCalls.every((call) => call.auth?.token === 'installation-token')).toBe(true);
    expect(commitCalls.every((call) => call.branch === 'main')).toBe(true);
    expect(commitCalls.every((call) => call.message === `chore: scaffold ${call.path}`)).toBe(true);
    // README.md is upserted via sha because `auto_init: true` creates one
    // on repo creation. Every other file is brand-new.
    const readmeIdx = committedPaths.indexOf('README.md');
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
    expect(gitConnectionRows).toContainEqual(expect.objectContaining({
      projectId: PROJECT_ID,
      provider: 'github',
      repoUrl: 'https://github.com/kortix-org/company-os.git',
      repoOwner: 'kortix-org',
      repoName: 'company-os',
      externalRepoId: '7',
      authMethod: 'github_app',
      installationId: '42',
      visibility: 'private',
      status: 'connected',
    }));
    expect(grantedProjectRole).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      projectRole: 'manager',
      grantedBy: USER_ID,
    });
  });
});
