import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountMembers,
  projectGitConnections,
  projectGitCredentials,
  projectMembers,
  projectSecrets,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const SESSION_ID = '00000000-0000-4000-a000-000000000301';
const TEST_GITHUB_OWNER = 'kortix-org';
const PROJECT_RUNTIME_PAT = 'kortix_pat_project_runtime';
const PROJECT_SANDBOX_TOKEN = 'kortix_sb_project_runtime';
const ORIGINAL_KORTIX_GITHUB_OWNER = process.env.KORTIX_GITHUB_OWNER;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;

process.env.KORTIX_GITHUB_OWNER = TEST_GITHUB_OWNER;
process.env.API_KEY_SECRET = 'test-project-secret-key-material-32-bytes';

let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let activeSessionCount = 0;
let sessionRow: typeof projectSessions.$inferSelect | null;
let sessionSandboxRows: Array<typeof sessionSandboxes.$inferSelect>;
let secretRows: Array<typeof projectSecrets.$inferSelect>;
let secretValues: Map<string, string>;
let gitConnectionRows: Array<typeof projectGitConnections.$inferSelect>;
let gitCredentialRows: Array<typeof projectGitCredentials.$inferSelect>;
let lastProvisionInput: {
  sandboxId: string;
  accountId: string;
  projectId: string;
  userId: string;
  provider?: string;
  extraEnvVars?: Record<string, string>;
  metadata?: Record<string, unknown>;
} | null = null;

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Contract Project',
  repoUrl: `https://github.com/${TEST_GITHUB_OWNER}/contract-project.git`,
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: { github: { auth_source: 'pat', full_name: `${TEST_GITHUB_OWNER}/contract-project` } },
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function resetState() {
  branchCreateCalls = 0;
  sandboxProvisionCalls = 0;
  activeSessionCount = 0;
  lastProvisionInput = null;
  projectRow.repoUrl = `https://github.com/${TEST_GITHUB_OWNER}/contract-project.git`;
  projectRow.defaultBranch = 'main';
  projectRow.metadata = { github: { auth_source: 'pat', full_name: `${TEST_GITHUB_OWNER}/contract-project` } };
  sessionRow = {
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: SESSION_ID,
    baseRef: 'main',
    sandboxProvider: 'local_docker',
    sandboxId: SESSION_ID,
    sandboxUrl: null,
    opencodeSessionId: null,
    agentName: 'default',
    status: 'provisioning',
    error: null,
    metadata: { existing: true },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  sessionSandboxRows = [];
  secretRows = [];
  secretValues = new Map();
  gitConnectionRows = [];
  gitCredentialRows = [];
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    if (c.req.header('Authorization') === `Bearer ${PROJECT_SANDBOX_TOKEN}`) {
      c.set('userId', ACCOUNT_ID);
      c.set('userEmail', '');
      c.set('authType', 'apiKey');
      c.set('apiKeyType', 'sandbox');
      c.set('accountId', ACCOUNT_ID);
      c.set('sandboxId', SESSION_ID);
      await next();
      return;
    }
    if (c.req.header('Authorization') === `Bearer ${PROJECT_RUNTIME_PAT}`) {
      c.set('userId', USER_ID);
      c.set('userEmail', '');
      c.set('authType', 'pat');
      c.set('accountId', ACCOUNT_ID);
      c.set('tokenProjectId', PROJECT_ID);
      c.set('iamTokenId', '00000000-0000-4000-a000-000000000901');
      await next();
      return;
    }
    c.set('userId', USER_ID);
    c.set('userEmail', 'contract@example.test');
    c.set('authType', 'supabase');
    await next();
  },
}));

mock.module('../projects/git', () => ({
  createRemoteSessionBranch: async () => {
    branchCreateCalls += 1;
  },
  archiveRepoSubtree: async () => undefined,
  deleteRemoteSessionBranch: async () => undefined,
  listRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  grepRepoFiles: async () => [],
  loadProjectConfig: async () => ({}),
  readRepoFile: async () => '',
  invalidateProjectMirror: () => {},
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  diffStat: async () => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  getFileAtRef: async () => null,
  resolveCommitSha: async () => 'a'.repeat(40),
  resolveBranchTip: async () => 'a'.repeat(40),
  getBranchDiff: async () => ({ files: [], diff: '' }),
  getDiffBetweenShas: async () => ({ files: [], diff: '' }),
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
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  verifyGitHubAppInstallState: (state: string) => state,
  verifyGitHubAppInstallStatePayload: (state: string) => ({
    accountId: state,
    nonce: 'test-nonce',
    issuedAt: Math.floor(Date.now() / 1000),
  }),
  getGitHubPatAuthContext: () => ({ token: 'pat-token', source: 'pat', owner: 'kortix-org' }),
  deleteFile: async () => undefined,
  commitFile: async () => undefined,
  createInstallationToken: async () => ({ token: 'installation-token' }),
  createRepo: async () => {
    throw new Error('not used');
  },
  getFileSha: async () => null,
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: {},
  }),
  getRepo: async () => ({
    id: 7,
    name: 'contract-project',
    full_name: 'kortix-org/contract-project',
    private: true,
    html_url: 'https://github.com/kortix-org/contract-project',
    clone_url: 'https://github.com/kortix-org/contract-project.git',
    ssh_url: 'git@github.com:kortix-org/contract-project.git',
    default_branch: 'main',
    description: null,
  }),
  listInstallationRepositories: async () => [],
  isGithubAppConfigured: () => false,
  isGithubPatConfigured: () => true,
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async (input: any) => {
    sandboxProvisionCalls += 1;
    lastProvisionInput = input;
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mockIamEngineAllowAll();

mockIamMembershipSyncNoop();

mock.module('../repositories/account-tokens', () => ({
  createAccountToken: async () => ({ secretKey: PROJECT_RUNTIME_PAT }),
  listAccountTokens: async () => [],
  revokeAccountToken: async () => true,
}));

// Pin the concurrent-session cap to 1 regardless of env mode so this test
// always exercises the rate-limit branch — the real implementation bypasses
// the cap when KORTIX_BILLING_INTERNAL_ENABLED is false.
mock.module('../shared/account-limits', () => ({
  resolveAccountTier: async () => 'free',
  maxConcurrentSessionsForTier: () => 1,
  sessionLlmPolicyForTier: () => ({ limit: 60, windowMs: 60_000 }),
  clearAccountLimitCache: () => undefined,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'contract@example.test' } } }),
      },
    },
  }),
}));

mock.module('../shared/db', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => {
            Promise.resolve(table === projectSecrets ? secretRows : []).then(resolve, reject);
          },
          orderBy: async () => {
            if (table === projectSecrets) return secretRows;
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            return [];
	          },
	          limit: async () => {
            if (fields && Object.keys(fields).includes('activeCount')) return [{ activeCount: activeSessionCount }];
            if (table === projectSecrets) {
              return secretRows.filter((row) => row.name === 'KORTIX_GIT_AUTH_TOKEN').slice(0, 1);
            }
            if (table === projectGitConnections) return gitConnectionRows.slice(0, 1);
            if (table === projectGitCredentials) return gitCredentialRows.slice(0, 1);
            if (table === sessionSandboxes) return sessionSandboxRows.slice(0, 1);
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
            if (table === projectMembers) return [];
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            return [];
          },
        }),
        orderBy: async () => {
          if (table === projectSessions) return sessionRow ? [sessionRow] : [];
          if (table === projectSecrets) return secretRows;
          return [];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        returning: async () => {
          if (table === projectGitConnections) {
            const existingIndex = gitConnectionRows.findIndex((row) => row.projectId === values.projectId);
            const now = new Date('2026-01-02T00:00:00Z');
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
              lastValidatedAt: values.lastValidatedAt ?? now,
              lastErrorCode: values.lastErrorCode ?? null,
              lastErrorMessage: values.lastErrorMessage ?? null,
              metadata: values.metadata ?? {},
              createdAt: existingIndex >= 0 ? gitConnectionRows[existingIndex]!.createdAt : now,
              updatedAt: values.updatedAt ?? now,
            } as typeof projectGitConnections.$inferSelect;
            if (existingIndex >= 0) gitConnectionRows[existingIndex] = row;
            else gitConnectionRows.push(row);
            return [row];
          }
          if (table === projectGitCredentials) {
            const existingIndex = gitCredentialRows.findIndex((row) =>
              row.projectId === values.projectId && row.provider === values.provider,
            );
            const now = new Date('2026-01-02T00:00:00Z');
            const row = {
              credentialId: existingIndex >= 0
                ? gitCredentialRows[existingIndex]!.credentialId
                : '00000000-0000-4000-a000-000000000601',
              accountId: values.accountId,
              projectId: values.projectId,
              provider: values.provider,
              authMethod: values.authMethod ?? 'token',
              valueEnc: values.valueEnc,
              createdBy: values.createdBy ?? null,
              createdAt: existingIndex >= 0 ? gitCredentialRows[existingIndex]!.createdAt : now,
              updatedAt: values.updatedAt ?? now,
            } as typeof projectGitCredentials.$inferSelect;
            if (existingIndex >= 0) gitCredentialRows[existingIndex] = row;
            else gitCredentialRows.push(row);
            return [row];
          }
          if (table !== projectSessions) return [];
          sessionRow = {
            sessionId: values.sessionId,
            accountId: values.accountId,
            projectId: values.projectId,
            branchName: values.branchName,
            baseRef: values.baseRef,
            sandboxProvider: values.sandboxProvider,
            sandboxId: values.sandboxId,
            sandboxUrl: null,
            opencodeSessionId: null,
            agentName: values.agentName,
            status: values.status,
            error: null,
            metadata: values.metadata ?? {},
            createdAt: new Date('2026-01-02T00:00:00Z'),
            updatedAt: values.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
          };
          return [sessionRow];
        },
        onConflictDoUpdate: ({ set }: { set: Partial<typeof projectSecrets.$inferInsert> }) => ({
          returning: async () => {
            if (table === projectGitConnections) {
              const existingIndex = gitConnectionRows.findIndex((row) => row.projectId === values.projectId);
              const now = new Date('2026-01-02T00:00:00Z');
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
                lastValidatedAt: values.lastValidatedAt ?? now,
                lastErrorCode: values.lastErrorCode ?? null,
                lastErrorMessage: values.lastErrorMessage ?? null,
                metadata: values.metadata ?? {},
                createdAt: existingIndex >= 0 ? gitConnectionRows[existingIndex]!.createdAt : now,
                updatedAt: values.updatedAt ?? now,
              } as typeof projectGitConnections.$inferSelect;
              if (existingIndex >= 0) gitConnectionRows[existingIndex] = row;
              else gitConnectionRows.push(row);
              return [row];
            }
            if (table === projectGitCredentials) {
              const existingIndex = gitCredentialRows.findIndex((row) =>
                row.projectId === values.projectId && row.provider === values.provider,
              );
              const now = new Date('2026-01-02T00:00:00Z');
              const row = {
                credentialId: existingIndex >= 0
                  ? gitCredentialRows[existingIndex]!.credentialId
                  : '00000000-0000-4000-a000-000000000601',
                accountId: values.accountId,
                projectId: values.projectId,
                provider: values.provider,
                authMethod: values.authMethod ?? 'token',
                valueEnc: values.valueEnc,
                createdBy: values.createdBy ?? null,
                createdAt: existingIndex >= 0 ? gitCredentialRows[existingIndex]!.createdAt : now,
                updatedAt: values.updatedAt ?? now,
              } as typeof projectGitCredentials.$inferSelect;
              if (existingIndex >= 0) gitCredentialRows[existingIndex] = row;
              else gitCredentialRows.push(row);
              return [row];
            }
            if (table !== projectSecrets) return [];
            const existingIndex = secretRows.findIndex((row) =>
              row.projectId === values.projectId && row.name === values.name,
            );
            const now = new Date('2026-01-02T00:00:00Z');
            const row: typeof projectSecrets.$inferSelect = {
              secretId: existingIndex >= 0 ? secretRows[existingIndex]!.secretId : '00000000-0000-4000-a000-000000000401',
              projectId: values.projectId!,
              name: values.name!,
              valueEnc: (set.valueEnc ?? values.valueEnc)!,
              createdBy: values.createdBy ?? null,
              createdAt: existingIndex >= 0 ? secretRows[existingIndex]!.createdAt : now,
              updatedAt: (set.updatedAt ?? values.updatedAt ?? now) as Date,
            };
            if (existingIndex >= 0) secretRows[existingIndex] = row;
            else secretRows.push(row);
            return [row];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectSecrets) secretRows = [];
      },
    }),
    update: (table: unknown) => ({
      set: (updates: Partial<typeof projectSessions.$inferSelect>) => ({
        where: () => ({
          returning: async () => {
            if (table !== projectSessions) return [];
            if (!sessionRow) return [];
            sessionRow = {
              ...sessionRow,
              ...updates,
              updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
            };
            return [sessionRow];
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
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

/** Poll until predicate holds (or timeout) — robustly flushes the
 *  fire-and-forget sandbox-provision IIFE instead of a single racy tick. */
async function flushUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('project session API contract', () => {
  afterAll(() => {
    mock.restore();
    if (ORIGINAL_KORTIX_GITHUB_OWNER === undefined) {
      delete process.env.KORTIX_GITHUB_OWNER;
    } else {
      process.env.KORTIX_GITHUB_OWNER = ORIGINAL_KORTIX_GITHUB_OWNER;
    }
    if (ORIGINAL_API_KEY_SECRET === undefined) {
      delete process.env.API_KEY_SECRET;
    } else {
      process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
    }
  });

  beforeEach(() => resetState());

  test('upserts and lists project secrets without exposing secret values', async () => {
    const app = createApp();

    const writeRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'OPENAI_API_KEY',
        value: 'sk-live-secret',
      }),
    });

    expect(writeRes.status).toBe(200);
    const written = await writeRes.json();
    expect(written.name).toBe('OPENAI_API_KEY');
    expect(written.scope).toBeUndefined();
    expect(written.value).toBeUndefined();
    expect(written.value_enc).toBeUndefined();
    expect(secretRows[0]?.valueEnc).not.toContain('sk-live-secret');

    const listRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets`);
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    const openAiSecret = listed.items.find((item: any) => item.name === 'OPENAI_API_KEY');
    const gitAuthSecret = listed.items.find((item: any) => item.name === 'KORTIX_GIT_AUTH_TOKEN');
    expect(openAiSecret).toBeTruthy();
    expect(openAiSecret.value).toBeUndefined();
    expect(openAiSecret.value_enc).toBeUndefined();
    expect(gitAuthSecret).toBeUndefined();
    expect(Array.isArray(listed.required)).toBe(true);
    expect(Array.isArray(listed.optional)).toBe(true);

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets/openai_api_key`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(secretRows).toHaveLength(0);
  });

  test('stores provider-neutral git credentials outside runtime project secrets', async () => {
    projectRow.repoUrl = 'https://gitlab.com/acme/private-project.git';
    projectRow.metadata = { git: { provider: 'gitlab', auth: { method: 'none' } } };
    const app = createApp();

    const before = await app.request(`/v1/projects/${PROJECT_ID}/secrets`);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.items.find((item: any) => item.name === 'KORTIX_GIT_AUTH_TOKEN')).toBeUndefined();

    const writeRes = await app.request(`/v1/projects/${PROJECT_ID}/git-credential`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'gitlab-project-token' }),
    });
    expect(writeRes.status).toBe(200);
    const written = await writeRes.json();
    expect(written).toMatchObject({
      configured: true,
      provider: 'gitlab',
      git_connection: {
        provider: 'gitlab',
        repo_url: 'https://gitlab.com/acme/private-project.git',
        auth_method: 'project_credential',
        status: 'connected',
      },
    });
    expect(written.value).toBeUndefined();
    expect(written.value_enc).toBeUndefined();
    expect(secretRows).toHaveLength(0);
    expect(gitCredentialRows).toHaveLength(1);
    expect(gitConnectionRows).toHaveLength(1);

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets/KORTIX_GIT_AUTH_TOKEN`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(403);
    expect(secretRows).toHaveLength(0);

    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);

    await flushUntil(() => lastProvisionInput !== null);
    const env = lastProvisionInput!.extraEnvVars ?? {};
    expect(env.KORTIX_GIT_AUTH_TOKEN).toBeUndefined();
    expect(env.KORTIX_GITHUB_TOKEN).toBeUndefined();
    expect(env.KORTIX_CLI_TOKEN).toBeUndefined();
    expect(env.KORTIX_TOKEN).toBeUndefined();

    sessionSandboxRows = [{
      sandboxId: SESSION_ID,
      sessionId: sessionRow!.sessionId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      provider: 'daytona',
      externalId: null,
      baseUrl: null,
      status: 'provisioning',
      config: {},
      metadata: {},
      lastUsedAt: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    }];

    const cloneRes = await app.request(`/v1/projects/${PROJECT_ID}/git/clone-credential`, {
      headers: { Authorization: `Bearer ${PROJECT_SANDBOX_TOKEN}` },
    });
    expect(cloneRes.status).toBe(200);
    expect(await cloneRes.json()).toMatchObject({
      repo_url: 'https://gitlab.com/acme/private-project.git',
      source: 'project_credential',
      auth: {
        username: 'x-access-token',
        token: 'gitlab-project-token',
        type: 'basic',
      },
    });
  });

  test('rejects reserved platform secret names', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'KORTIX_TOKEN',
        value: 'should-not-shadow-platform-auth',
      }),
    });

    expect(res.status).toBe(400);
    expect(secretRows).toHaveLength(0);
  });

  test('rejects server-managed and unknown PATCH fields', async () => {
    const app = createApp();
    const forbiddenBodies: Array<{ body: Record<string, unknown>; message: string }> = [
      { body: { status: 'running' }, message: 'field is server-managed: status' },
      { body: { sandbox_url: 'https://sandbox.example' }, message: 'field is server-managed: sandbox_url' },
      { body: { sandboxUrl: 'https://sandbox.example' }, message: 'field is server-managed: sandboxUrl' },
      { body: { error: 'client-owned' }, message: 'field is server-managed: error' },
      { body: { random: 'field' }, message: 'field is not user-editable: random' },
    ];

    for (const { body, message } of forbiddenBodies) {
      const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: message });
    }
  });

  test('returns deterministic read errors for invalid or missing sessions and pending sandboxes', async () => {
    const app = createApp();

    const listSessions = await app.request(`/v1/projects/${PROJECT_ID}/sessions`);
    expect(listSessions.status).toBe(200);
    const sessions = await listSessions.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: SESSION_ID,
      project_id: PROJECT_ID,
      branch_name: SESSION_ID,
      sandbox_id: SESSION_ID,
      status: 'provisioning',
    });

    const readSession = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`);
    expect(readSession.status).toBe(200);
    expect(await readSession.json()).toMatchObject({
      session_id: SESSION_ID,
      project_id: PROJECT_ID,
      branch_name: SESSION_ID,
      sandbox_id: SESSION_ID,
      status: 'provisioning',
    });

    const invalidSession = await app.request(`/v1/projects/${PROJECT_ID}/sessions/not-a-uuid`);
    expect(invalidSession.status).toBe(400);
    expect(await invalidSession.json()).toMatchObject({ error: 'Invalid session id' });

    const invalidSandbox = await app.request(`/v1/projects/${PROJECT_ID}/sessions/not-a-uuid/sandbox`);
    expect(invalidSandbox.status).toBe(400);
    expect(await invalidSandbox.json()).toMatchObject({ error: 'Invalid session id' });

    const pendingSandbox = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/sandbox`);
    expect(pendingSandbox.status).toBe(404);
    expect(await pendingSandbox.json()).toMatchObject({ error: 'Not found' });

    sessionRow = null;
    const missingSession = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`);
    expect(missingSession.status).toBe(404);
    expect(await missingSession.json()).toMatchObject({ error: 'Not found' });
  });

  test('allows only user-owned PATCH fields', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Human name',
        opencode_session_id: 'oc-123',
        metadata: { custom: 'ok' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Human name');
    expect(body.opencode_session_id).toBe('oc-123');
    expect(body.status).toBe('provisioning');
    expect(body.metadata).toEqual({ existing: true, custom: 'ok', name: 'Human name' });
  });

  test('rejects unknown providers before creating a git branch', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'justavps' }),
    });

    expect(res.status).toBe(400);
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // End-to-end: stored project secrets must land in the sandbox env at session
  // create. This is the contract the entire Secrets Manager UX relies on —
  // anything stored via POST /secrets is expected to be a plain env var at
  // sandbox boot, alongside the platform-managed KORTIX_* envelope.
  // ---------------------------------------------------------------------------
  test('e2e: stored project secrets are injected as plaintext env vars at session create', async () => {
    const app = createApp();

    // 1. User stores two secrets via the Secrets Manager.
    for (const [name, value] of [
      ['OPENAI_API_KEY', 'sk-test-openai'],
      ['STRIPE_SECRET', 'sk_test_stripe_live'],
    ] as const) {
      const writeRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value }),
      });
      expect(writeRes.status).toBe(200);
    }
    expect(secretRows).toHaveLength(2);
    // Stored values are encrypted at rest — plaintext never appears in valueEnc.
    for (const row of secretRows) {
      expect(row.valueEnc).not.toContain('sk-test-openai');
      expect(row.valueEnc).not.toContain('sk_test_stripe_live');
    }

    // 2. User creates a session — sandbox provisioning is fire-and-forget.
    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);

    // 3. Flush the fire-and-forget IIFE that calls provisionSessionSandbox.
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionInput).not.toBeNull();

    // 4. User secrets are present, decrypted, in extraEnvVars.
    const env = lastProvisionInput!.extraEnvVars ?? {};
    expect(env.OPENAI_API_KEY).toBe('sk-test-openai');
    expect(env.STRIPE_SECRET).toBe('sk_test_stripe_live');

    // 5. Platform KORTIX_* envelope is still present alongside user secrets.
    // Git provider credentials are deliberately absent; provisionSessionSandbox
    // injects the single sandbox KORTIX_TOKEN at the provider boundary.
    expect(env.KORTIX_PROJECT_ID).toBe(PROJECT_ID);
    expect(env.KORTIX_SESSION_ID).toBeTruthy();
    expect(env.KORTIX_REPO_URL).toBe(projectRow.repoUrl);
    expect(env.KORTIX_BASE_REF).toBe('main');
    // LLM/tool-router URLs are no longer injected — the sandbox derives any
    // router endpoint it needs from KORTIX_API_URL.
    expect(env.KORTIX_LLM_TOKEN).toBeUndefined();
    expect(env.KORTIX_LLM_BASE_URL).toBeUndefined();
    expect(env.TAVILY_API_URL).toBeUndefined();
    expect(env.KORTIX_CLI_TOKEN).toBeUndefined();
    expect(env.KORTIX_TOKEN).toBeUndefined();
    expect(env.KORTIX_API_URL).toBeTruthy();
    expect(env.KORTIX_GIT_AUTH_TOKEN).toBeUndefined();
    expect(env.KORTIX_GITHUB_TOKEN).toBeUndefined();

    // 6. User can't shadow a platform var — POST /secrets rejects KORTIX_*.
    // This protects the env-var precedence: user secrets are merged before
    // KORTIX_* in the helper, so an accepted KORTIX_TOKEN would silently
    // poison the sandbox auth.
    const shadowRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'KORTIX_TOKEN', value: 'phishy' }),
    });
    expect(shadowRes.status).toBe(400);
  });

  test('creates a session with the required id, branch, and sandbox invariant', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        name: 'Contract session',
        agent_name: 'reviewer',
        initial_prompt: 'Review the repo',
      }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    const body = await res.json();
    expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.session_id).toBe(body.sandbox_id);
    expect(body.session_id).toBe(body.branch_name);
    expect(body.sandbox_provider).toBe('daytona');
    expect(body.status).toBe('provisioning');
    expect(body.name).toBe('Contract session');
    expect(branchCreateCalls).toBe(1);

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
  });

  test('accepts a client-created session branch without recreating it server-side', async () => {
    const app = createApp();
    const clientSessionId = '11111111-1111-4111-a111-111111111111';
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: clientSessionId,
        branch_already_created: true,
        base_ref: 'main',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session_id).toBe(clientSessionId);
    expect(body.branch_name).toBe(clientSessionId);
    expect(branchCreateCalls).toBe(0);

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
  });

  test('stops a session without deleting its preserved branch row', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sessionRow?.status).toBe('stopped');
    expect(sessionRow?.branchName).toBe(SESSION_ID);

    sessionRow = null;
    const missing = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'Not found' });
  });

  test('rejects concurrent session cap before creating a git branch', async () => {
    activeSessionCount = 1;
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona' }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(await res.json()).toMatchObject({
      error: 'concurrent session limit',
      limit: 1,
      active_sessions: 1,
    });
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });
});
