import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
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
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// The starter is a folder under `packages/starter/templates/base/` —
// `getStarterFiles()` walks it and returns the files sorted by path
// (case-insensitive, via localeCompare). This list is the contract:
// "every project ships with these, in this order."
// The minimal starter == the shared `templates/base` tree (no general-knowledge
// -worker skill pack). Ordered by `path.localeCompare` to match getStarterFiles'
// stable sort. Regenerate from `packages/starter/templates/base` when the base
// scaffold changes.
// The starter floor ships the core Kortix OpenCode files plus default runtime
// tools/plugins. Optional skills (agent-browser and knowledge-work skills) are
// marketplace installable instead.
const BASE_STARTER_PATHS = [
  '.gitignore',
  '.kortix/memory/MEMORY.md',
  '.kortix/opencode/agents/kortix.md',
  '.kortix/opencode/agents/memory-reflector.md',
  '.kortix/opencode/bun.lock',
  '.kortix/opencode/opencode.jsonc',
  '.kortix/opencode/package.json',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/constants.ts',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/pty/buffer.ts',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/pty/formatters.ts',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/pty/manager.ts',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/pty/permissions.ts',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/pty/session-lifecycle.ts',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/pty/types.ts',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/pty/wildcard.ts',
  '.kortix/opencode/plugins/opencode-pty/src/plugin/types.ts',
  '.kortix/opencode/plugins/opencode-pty/src/shared/constants.ts',
  '.kortix/opencode/plugins/pty.ts',
  '.kortix/opencode/skills/kortix-executor/references/executor-sdk.md',
  '.kortix/opencode/skills/kortix-executor/SKILL.md',
  '.kortix/opencode/skills/kortix-marketplace/SKILL.md',
  '.kortix/opencode/skills/kortix-memory/SKILL.md',
  '.kortix/opencode/skills/kortix-onboarding/SKILL.md',
  '.kortix/opencode/skills/kortix-slack/SKILL.md',
  '.kortix/opencode/skills/kortix-system/references/authoring-skills.md',
  '.kortix/opencode/skills/kortix-system/references/capabilities.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/change-requests.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/credentials-and-setup-links.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/kortix-yaml.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/marketplace.md',
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
  '.kortix/opencode/skills/kortix-system/references/scheduling.md',
  '.kortix/opencode/skills/kortix-system/SKILL.md',
  '.kortix/opencode/skills/kortix-teams/SKILL.md',
  '.kortix/opencode/skills/kortix-voice/SKILL.md',
  '.kortix/opencode/tools/image_search.ts',
  '.kortix/opencode/tools/lib/get-env.ts',
  '.kortix/opencode/tools/memory.ts',
  '.kortix/opencode/tools/scrape_webpage.ts',
  '.kortix/opencode/tools/show.ts',
  '.kortix/opencode/tools/web_search.ts',
  'kortix.yaml',
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
let ownerRepoListCalls: any[];
let nangoCredentialCalls: Array<{ accountId: string; installationId: string }>;
let deleteRepoCalls: any[];
let commitFailurePath: string | null;
let platformAdmin: boolean;

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
  ownerRepoListCalls = [];
  nangoCredentialCalls = [];
  deleteRepoCalls = [];
  commitFailurePath = null;
  platformAdmin = false;
  installationRows = [{
    installationRowId: '00000000-0000-4000-a000-000000000041',
    accountId: ACCOUNT_ID,
    installationId: '42',
    nangoConnectionId: 'nango-connection-42',
    nangoIntegrationId: 'github-app-oauth',
    connectionStatus: 'connected',
    lastValidatedAt: new Date('2026-01-01T00:00:00Z'),
    lastErrorCode: null,
    lastErrorMessage: null,
    disconnectedAt: null,
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

const realPlatformRoles = await import('../shared/platform-roles');
mock.module('../shared/platform-roles', () => ({
  ...realPlatformRoles,
  isPlatformAdmin: async () => platformAdmin,
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

mock.module('../projects/git', () => ({
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  createRemoteSessionBranch: async () => undefined,
  archiveRepoSubtree: async () => undefined,
  listRepoFiles: async () => [],
  loadProjectConfig: async () => ({ env: { required: [], optional: [] } }),
  readRepoFile: async () => '',
  readManifestFromRepo: async () => null,
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
  resolveBranchAheadState: async () => ({ ahead: false, baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40) }),
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
  kickRoutedPreBuild: () => {},
  templateBuildProviders: () => ['daytona', 'platinum', 'e2b'],
  kickProjectTemplatePrebuilds: () => {},
  reconcileStaleBuilds: async () => ({ healed: 0 }),
  reconcileProjectTemplates: async () => {},
  resolveCommitSha: async () => "a".repeat(40),
  ensurePerProjectWarmImage: async () => ({
    snapshotName: "kortix-ppwarm-test",
    tip: "a".repeat(40),
    built: false,
    provider: "daytona",
  }),
  DEFAULT_SANDBOX_SLUG: "default",
}));

const realGithubModule = await import('../projects/github');
mock.module('../projects/github', () => ({
  ...realGithubModule,
  deleteFile: async () => undefined,
  deleteRepo: async (input: any) => {
    deleteRepoCalls.push(input);
  },
  addCollaborator: async () => undefined,
  createBranchRef: async () => undefined,
  getBranchCommitSha: async () => 'a'.repeat(40),
  parseGitHubRepoUrl: (url: string) => {
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    return m ? { owner: m[1], repo: m[2] } : null;
  },
  commitFile: async (input: any) => {
    commitCalls.push(input);
    if (input.path === commitFailurePath) {
      throw new realGithubModule.GitHubApiError(
        'GitHub /repos/kortix-org/company-os failed (422): provider detail',
        422,
        '/repos/kortix-org/company-os',
      );
    }
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
  verifyGitHubInstallationAdmin: async (token: string) => {
    expect(token).toBe('github-user-token');
    return { login: 'github-admin' };
  },
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
    permissions: { push: true },
  }),
  getRepositoryBranch: async ({ branch }: { branch: string }) => ({
    name: branch,
    protected: false,
  }),
  // This mock handles both account Nango access and the managed PAT fallback.
  listOwnerRepositories: async (input: any) => {
    ownerRepoListCalls.push(input);
    return input.owner === 'acme'
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
          permissions: { push: true },
        }]
      : [];
  },
  listRepositoryBranches: async ({ owner, repo }: { owner: string; repo: string }) => [
    { name: owner === 'acme' && repo === 'portal' ? 'trunk' : 'main', protected: true },
    { name: 'dev', protected: false },
  ],
  isOrgAccount: async () => true,
  isGithubAppConfigured: () => true,
}));

globalThis.fetch = mock(async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const connectionId = decodeURIComponent(
    url.pathname.split('/connections/')[1] ?? '',
  );
  const installation = installationRows.find(
    (row) => row.nangoConnectionId === connectionId,
  );
  if (!installation?.nangoConnectionId || !installation.nangoIntegrationId) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  nangoCredentialCalls.push({
    accountId: installation.accountId,
    installationId: installation.installationId,
  });
  return Response.json({
    connection_id: installation.nangoConnectionId,
    provider_config_key: installation.nangoIntegrationId,
    provider: 'github-app-oauth',
    errors: [],
    metadata: {},
    connection_config: { installation_id: installation.installationId },
    tags: {
      kortix_account_id: installation.accountId,
      kortix_user_id: USER_ID,
      kortix_purpose: 'account',
      kortix_display_name: installation.ownerLogin,
      kortix_connect_attempt_id: '00000000-0000-4000-a000-000000000901',
    },
    credentials: {
      type: 'CUSTOM',
      app: {
        type: 'APP',
        access_token: `nango-installation-token-${installation.installationId}`,
        raw: {
          permissions: installation.permissions,
          repository_selection: installation.repositorySelection,
        },
      },
      user: {
        type: 'OAUTH2',
        access_token: `nango-user-token-${installation.installationId}`,
        raw: {},
      },
      raw: {},
    },
  });
}) as unknown as typeof fetch;

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
  upsertCreditAccount: async () => {},
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
  if (table === projects) {
    return [{
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'Company OS',
      repoUrl: 'https://github.com/kortix-org/company-os.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      status: 'active',
      metadata: {},
      lastOpenedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }];
  }
  if (table === projectGitConnections) {
    return gitConnectionRows;
  }
  return [];
}

function storedProject(values: any) {
  insertedProject = values;
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

const starterDbMock: any = {
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
        onConflictDoNothing: () => ({
          returning: async () => table === projects ? [storedProject(values)] : [],
        }),
        onConflictDoUpdate: () => {
          if (table === projectMembers) {
            const persist = () => {
              grantedProjectRole = values;
              return [values];
            };
            return {
              returning: async () => persist(),
              then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
                Promise.resolve(persist()).then(resolve, reject),
            };
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
                  nangoConnectionId: values.nangoConnectionId ?? null,
                  nangoIntegrationId: values.nangoIntegrationId ?? null,
                  connectionStatus: values.connectionStatus ?? null,
                  lastValidatedAt: values.lastValidatedAt ?? null,
                  lastErrorCode: values.lastErrorCode ?? null,
                  lastErrorMessage: values.lastErrorMessage ?? null,
                  disconnectedAt: values.disconnectedAt ?? null,
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
                upstreamUrl: values.upstreamUrl ?? null,
                managed: values.managed ?? false,
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
              return [storedProject(values)];
            },
          };
        },
        returning: async () => {
          if (table === projectGitConnections) {
            return starterDbMock.insert(table).values(values).onConflictDoUpdate({}).returning();
          }
          if (table === projectMembers) {
            grantedProjectRole = values;
            return [values];
          }
          if (table !== projects) return [];
          return [storedProject(values)];
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
};
starterDbMock.transaction = async (run: (tx: typeof starterDbMock) => Promise<unknown>) =>
  run(starterDbMock);

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: starterDbMock,
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

    // The full core ships as source (self-contained): tools, skills, agents.
    expect(files.find((file) => file.path === '.kortix/opencode/tools/show.ts')).toBeDefined();
    expect(files.find((file) => file.path === '.kortix/opencode/skills/kortix-system/SKILL.md')).toBeDefined();
    expect(files.find((file) => file.path === '.kortix/opencode/agents/kortix.md')).toBeDefined();
    // The manifest IS shipped and names the project.
    const manifest = files.find((file) => file.path === 'kortix.yaml');
    expect(manifest?.content).toContain('name: "Company OS"');
    expect(files.some((file) => file.path.includes('/agent-tunnel/'))).toBe(false);
  });

  test('defaults to the general knowledge worker starter', () => {
    const files = buildStarterFiles({
      projectName: 'Company OS',
      repoFullName: 'kortix-org/company-os',
    });
    const paths = files.map((file) => file.path);
    const explicitPaths = buildStarterFiles({
      projectName: 'Company OS',
      repoFullName: 'kortix-org/company-os',
      template: 'general-knowledge-worker',
    }).map((file) => file.path);

    expect(paths).toEqual(explicitPaths);
    for (const path of BASE_STARTER_PATHS) expect(paths).toContain(path);
    expect(paths).toContain('.kortix/opencode/skills/account-research/SKILL.md');
    expect(paths).toContain('.kortix/opencode/skills/pdf/SKILL.md');
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.some((path) => path.includes('/agent-tunnel/'))).toBe(false);
  });

  test('minimal starter remains an explicit internal option', () => {
    const files = buildStarterFiles({
      projectName: 'Company OS',
      repoFullName: 'kortix-org/company-os',
      template: 'minimal',
    });
    const paths = files.map((file) => file.path);

    expect(paths).toEqual(BASE_STARTER_PATHS);
    expect(paths).not.toContain('.kortix/opencode/skills/account-research/SKILL.md');
    expect(paths).not.toContain('.kortix/opencode/skills/pdf/SKILL.md');
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('serializes account Nango connection metadata through the project API', async () => {
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
      connection_id: 'nango-connection-42',
      connection_provider: 'nango',
      connection_status: 'connected',
      reconnect_required: false,
    });
  });

  test('lists multiple GitHub installations and imports from the selected one', async () => {
    installationRows.unshift({
      installationRowId: '00000000-0000-4000-a000-000000000084',
      accountId: ACCOUNT_ID,
      installationId: '84',
      nangoConnectionId: 'nango-connection-84',
      nangoIntegrationId: 'github-app-oauth',
      connectionStatus: 'connected',
      lastValidatedAt: new Date('2026-01-01T00:00:00Z'),
      lastErrorCode: null,
      lastErrorMessage: null,
      disconnectedAt: null,
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
      `/v1/projects/github/repositories?account_id=${ACCOUNT_ID}` +
        '&installation_id=84&search=portal&limit=25',
    );
    expect(repos.status).toBe(200);
    expect(await repos.json()).toMatchObject({
      account_id: ACCOUNT_ID,
      installation_id: '84',
      owner_login: 'acme',
      repositories: [{ full_name: 'acme/portal', default_branch: 'trunk' }],
    });
    expect(ownerRepoListCalls).toContainEqual({
      owner: 'acme',
      ownerType: 'Organization',
      search: 'portal',
      limit: 25,
      auth: { token: 'nango-user-token-84' },
    });

    const branches = await app.request(
      `/v1/projects/github/repository-branches?account_id=${ACCOUNT_ID}` +
        '&installation_id=84&repo_full_name=acme%2Fportal',
    );
    expect(branches.status).toBe(200);
    expect(await branches.json()).toEqual({
      account_id: ACCOUNT_ID,
      installation_id: '84',
      owner_login: 'acme',
      repo_full_name: 'acme/portal',
      default_branch: 'trunk',
      branches: [
        { name: 'trunk', protected: true },
        { name: 'dev', protected: false },
      ],
    });

    const linked = await app.request('/v1/projects/link-repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        installation_id: '84',
        repository_id: '84',
        repo_full_name: 'acme/portal',
      }),
    });
    expect(linked.status).toBe(201);
    expect(await linked.json()).toMatchObject({
      project: {
        repo_url: 'https://github.com/acme/portal.git',
        default_branch: 'trunk',
        project_role: 'manager',
        effective_project_role: 'manager',
      },
      git_connection: {
        provider: 'github',
        repo_owner: 'acme',
        repo_name: 'portal',
        installation_id: '84',
        auth_method: 'nango',
        credential_ref: 'nango-connection-84',
      },
    });
    expect(gitConnectionRows).toContainEqual(
      expect.objectContaining({
        projectId: PROJECT_ID,
        provider: 'github',
        authMethod: 'nango',
        installationId: '84',
        credentialRef: 'nango-connection-84',
        managed: false,
      }),
    );
    expect(nangoCredentialCalls).toEqual([
      { accountId: ACCOUNT_ID, installationId: '84' },
      { accountId: ACCOUNT_ID, installationId: '84' },
      { accountId: ACCOUNT_ID, installationId: '84' },
    ]);
  });

  test('rejects the removed synthetic PAT installation for repository discovery', async () => {
    installationRows = [];
    const app = createApp();
    const response = await app.request(
      `/v1/projects/github/repositories?account_id=${ACCOUNT_ID}` +
        '&installation_id=pat&search=customer%20portal&limit=25',
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'github_connection_required',
      requires_human_oauth: true,
    });
    expect(ownerRepoListCalls).toEqual([]);
  });

  test('does not expose or import through a removed server PAT', async () => {
    installationRows = [];

    const app = createApp();
    const installations = await app.request(
      `/v1/projects/github/installations?account_id=${ACCOUNT_ID}`,
    );
    expect(installations.status).toBe(200);
    expect(await installations.json()).toMatchObject({
      installed: false,
      installations: [],
    });

    const repositories = await app.request(
      `/v1/projects/github/repositories?account_id=${ACCOUNT_ID}&installation_id=pat`,
    );
    expect(repositories.status).toBe(409);
    expect(await repositories.json()).toMatchObject({
      code: 'github_connection_required',
      requires_human_oauth: true,
    });
    expect(ownerRepoListCalls).toEqual([]);

    const linked = await app.request('/v1/projects/link-repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        installation_id: 'pat',
        repo_full_name: 'managed-kortix/private-repo',
      }),
    });
    expect(linked.status).toBe(409);
    expect(await linked.json()).toMatchObject({
      code: 'github_reconnect_required',
      requires_human_oauth: true,
    });
  });

  test('commits the default starter scaffold with the account Nango user token before registering the project', async () => {
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
    expect(body.metadata.github.auth_source).toBe('nango');

    expect(repoCreateCalls).toHaveLength(1);
    expect(repoCreateCalls[0]).toMatchObject({
      name: 'company-os',
      isPrivate: true,
      autoInit: true,
      auth: {
        token: 'nango-user-token-42',
        source: 'nango',
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
      auth: { token: 'nango-user-token-42', source: 'nango' },
    });

    const committedPaths = commitCalls.map((call) => call.path);
    for (const path of BASE_STARTER_PATHS) expect(committedPaths).toContain(path);
    expect(committedPaths).toContain('.kortix/opencode/skills/account-research/SKILL.md');
    expect(committedPaths).toContain('.kortix/opencode/skills/pdf/SKILL.md');
    expect(commitCalls.every((call) => call.auth?.token === 'nango-user-token-42')).toBe(true);
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
      manifestPath: 'kortix.yaml',
      status: 'active',
      metadata: {
        github: {
          full_name: 'kortix-org/company-os',
          html_url: 'https://github.com/kortix-org/company-os',
          private: true,
          auth_source: 'nango',
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
      authMethod: 'nango',
      credentialRef: 'nango-connection-42',
      installationId: '42',
      managed: true,
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
    expect(nangoCredentialCalls).toEqual([
      { accountId: ACCOUNT_ID, installationId: '42' },
    ]);
  });

  test('rolls back the GitHub repository when starter scaffolding fails', async () => {
    commitFailurePath = 'kortix.yaml';

    const app = createApp();
    const response = await app.request('/v1/projects/create-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        installation_id: '42',
        name: 'company-os',
        project_name: 'Company OS',
        private: true,
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Failed to scaffold starter file kortix.yaml. GitHub rejected the operation.',
      code: 'github_provider_failed',
    });
    expect(deleteRepoCalls).toEqual([
      {
        owner: 'kortix-org',
        repo: 'company-os',
        auth: {
          token: 'nango-user-token-42',
          source: 'nango',
          owner: 'kortix-org',
          ownerType: 'Organization',
          installationId: '42',
        },
      },
    ]);
    expect(insertedProject).toBeNull();
  });

  test("commits a selected marketplace project template into the new GitHub repository", async () => {
    const app = createApp();
    const res = await app.request("/v1/projects/create-repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: "company-os",
        project_name: "Company OS",
        private: true,
        source_item_id: "kortix-projects:starter",
      }),
    });

    expect(res.status).toBe(201);
    expect(commitCalls.map((call) => call.path)).toContain(
      ".kortix/opencode/skills/account-research/SKILL.md",
    );
    expect(
      commitCalls.find((call) => call.path === "kortix.yaml")?.content,
    ).toContain('name: "Company OS"');
    expect(gitConnectionRows).toContainEqual(
      expect.objectContaining({
        projectId: PROJECT_ID,
        provider: "github",
        managed: true,
      }),
    );
  });

  test("commits the SEO Department marketplace project into the new GitHub repository", async () => {
    const app = createApp();
    const res = await app.request("/v1/projects/create-repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: "seo-team",
        project_name: "Acme SEO",
        private: true,
        source_item_id: "kortix-projects:seo-department",
      }),
    });

    expect(res.status).toBe(201);
    expect(commitCalls.map((call) => call.path)).toEqual(
      expect.arrayContaining([
        ".kortix/opencode/agents/seo-director.md",
        ".kortix/opencode/agents/technical-seo.md",
        ".kortix/opencode/agents/content-strategist.md",
        ".kortix/opencode/agents/serp-analyst.md",
        ".kortix/opencode/agents/seo-repo-watchdog.md",
        ".kortix/opencode/skills/seo-operating-system/SKILL.md",
        ".kortix/opencode/skills/technical-seo-audit/SKILL.md",
        ".kortix/opencode/skills/seo-repo-monitoring/SKILL.md",
        ".kortix/opencode/skills/content-seo-workflow/SKILL.md",
        ".kortix/opencode/skills/serp-intelligence/SKILL.md",
        ".kortix/memory/SEO.md",
        "install.md",
      ]),
    );
    const manifest = commitCalls.find((call) => call.path === "kortix.yaml")?.content;
    expect(manifest).toContain('name: "Acme SEO"');
    expect(manifest).toContain("default_agent: seo-director");
    expect(manifest).toContain("daily-serp-watch");
    expect(manifest).toContain("repo-seo-watch");
    expect(manifest).toContain("daily-repo-seo-sweep");
    expect(manifest).toContain("weekly-technical-audit");
    expect(manifest).toContain("weekly-content-refresh");
    expect(manifest).toContain("monthly-seo-growth-report");
    expect(gitConnectionRows).toContainEqual(
      expect.objectContaining({
        projectId: PROJECT_ID,
        provider: "github",
        managed: true,
      }),
    );
  });

  test('rejects hidden marketplace projects before creating a GitHub repository', async () => {
    const app = createApp();
    const res = await app.request('/v1/projects/create-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'internal-project',
        source_item_id: 'kortix-projects:web-studio',
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Unknown or non-cloneable project item "kortix-projects:web-studio"',
    });
    expect(repoCreateCalls).toHaveLength(0);
  });
});
