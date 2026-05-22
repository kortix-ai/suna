import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, projectMembers, projectSecrets, projectSessions, projects } from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const SESSION_ID = '00000000-0000-4000-a000-000000000301';
const TEST_GITHUB_OWNER = 'kortix-org';
const ORIGINAL_KORTIX_GITHUB_OWNER = process.env.KORTIX_GITHUB_OWNER;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;

process.env.KORTIX_GITHUB_OWNER = TEST_GITHUB_OWNER;
process.env.API_KEY_SECRET = 'test-project-secret-key-material-32-bytes';

let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let activeSessionCount = 0;
let sessionRow: typeof projectSessions.$inferSelect | null;
let secretRows: Array<typeof projectSecrets.$inferSelect>;
let secretValues: Map<string, string>;
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
  secretRows = [];
  secretValues = new Map();
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'contract@example.test');
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

mock.module('../vault', () => ({
  upsertProjectItem: async (input: {
    projectId: string;
    name: string;
    value: string;
    kind?: string;
    ownerUserId?: string | null;
    createdBy: string;
  }) => {
    const existingIndex = secretRows.findIndex((row) =>
      row.projectId === input.projectId &&
      row.name === input.name &&
      (row as any).ownerUserId === (input.ownerUserId ?? null),
    );
    const now = new Date('2026-01-02T00:00:00Z');
    const row = {
      secretId: existingIndex >= 0
        ? secretRows[existingIndex]!.secretId
        : `00000000-0000-4000-a000-${String(401 + secretRows.length).padStart(12, '0')}`,
      projectId: input.projectId,
      name: input.name,
      valueEnc: `enc:${Buffer.from(input.value).toString('base64url')}`,
      createdBy: input.createdBy,
      createdAt: existingIndex >= 0 ? secretRows[existingIndex]!.createdAt : now,
      updatedAt: now,
      ownerUserId: input.ownerUserId ?? null,
    } as typeof projectSecrets.$inferSelect & { ownerUserId: string | null };
    if (existingIndex >= 0) secretRows[existingIndex] = row;
    else secretRows.push(row);
    secretValues.set(row.secretId, input.value);
    return {
      itemId: row.secretId,
      projectId: row.projectId,
      kind: input.kind ?? 'env',
      name: row.name,
      ownerUserId: row.ownerUserId,
      providerId: null,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
  listProjectItems: async (projectId: string) =>
    secretRows
      .filter((row) => row.projectId === projectId)
      .map((row: any) => ({
        itemId: row.secretId,
        projectId: row.projectId,
        kind: 'env',
        name: row.name,
        ownerUserId: row.ownerUserId ?? null,
        providerId: null,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        grantUserIds: [],
      })),
  deleteProjectItemByScope: async (projectId: string, name: string, ownerUserId: string | null) => {
    const removed = secretRows.filter((row: any) =>
      row.projectId === projectId &&
      row.name === name &&
      (row.ownerUserId ?? null) === ownerUserId,
    );
    for (const row of removed) secretValues.delete(row.secretId);
    secretRows = secretRows.filter((row: any) =>
      row.projectId !== projectId ||
      row.name !== name ||
      (row.ownerUserId ?? null) !== ownerUserId,
    );
  },
  setItemGrants: async () => {},
  visibilityOf: (item: { ownerUserId: string | null }, grantCount: number) =>
    item.ownerUserId ? 'private' : grantCount > 0 ? 'select' : 'everyone',
  resolveVaultForActor: async ({ projectId }: { projectId: string }) =>
    Object.fromEntries(
      secretRows
        .filter((row) => row.projectId === projectId)
        .map((row) => [row.name, secretValues.get(row.secretId) ?? '']),
    ),
  resolveProjectGlobalSecret: async (projectId: string, name: string) => {
    const row = secretRows.find((item) => item.projectId === projectId && item.name === name);
    return row ? secretValues.get(row.secretId) ?? null : null;
  },
}));

mockIamEngineAllowAll();

mockIamMembershipSyncNoop();

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

const { projectsApp, buildProjectLlmBaseUrl } = await import('../projects/index');

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

  test('builds the session LLM router URL from common API URL shapes', () => {
    expect(buildProjectLlmBaseUrl('https://api.kortix.com')).toBe('https://api.kortix.com/v1/router/llm');
    expect(buildProjectLlmBaseUrl('https://api.kortix.com/v1')).toBe('https://api.kortix.com/v1/router/llm');
    expect(buildProjectLlmBaseUrl('https://api.kortix.com/v1/router')).toBe('https://api.kortix.com/v1/router/llm');
    expect(buildProjectLlmBaseUrl('https://api.kortix.com/v1/router/')).toBe('https://api.kortix.com/v1/router/llm');
  });

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
    expect(gitAuthSecret).toMatchObject({
      name: 'KORTIX_GIT_AUTH_TOKEN',
      system: true,
      readonly: true,
      purpose: 'git_auth',
      configured: true,
      can_rotate: false,
      managed_by: 'kortix',
    });
    expect(gitAuthSecret.value).toBeUndefined();
    expect(gitAuthSecret.value_enc).toBeUndefined();
    expect(Array.isArray(listed.required)).toBe(true);
    expect(Array.isArray(listed.optional)).toBe(true);

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets/openai_api_key`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(secretRows).toHaveLength(0);
  });

  test('stores provider-neutral git credentials as non-deletable project secrets', async () => {
    projectRow.repoUrl = 'https://gitlab.com/acme/private-project.git';
    projectRow.metadata = { git: { provider: 'gitlab', auth: { method: 'none' } } };
    const app = createApp();

    const before = await app.request(`/v1/projects/${PROJECT_ID}/secrets`);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.items.find((item: any) => item.name === 'KORTIX_GIT_AUTH_TOKEN')).toMatchObject({
      system: true,
      readonly: true,
      purpose: 'git_auth',
      configured: false,
      can_rotate: true,
      managed_by: 'project_secret',
    });

    const writeRes = await app.request(`/v1/projects/${PROJECT_ID}/git-credential`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'gitlab-project-token' }),
    });
    expect(writeRes.status).toBe(200);
    const written = await writeRes.json();
    expect(written).toMatchObject({
      name: 'KORTIX_GIT_AUTH_TOKEN',
      system: true,
      readonly: true,
      purpose: 'git_auth',
      configured: true,
      can_rotate: true,
      managed_by: 'project_secret',
    });
    expect(written.value).toBeUndefined();
    expect(written.value_enc).toBeUndefined();

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets/KORTIX_GIT_AUTH_TOKEN`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(403);
    expect(secretRows).toHaveLength(1);

    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);

    await flushUntil(() => lastProvisionInput !== null);
    const env = lastProvisionInput!.extraEnvVars ?? {};
    expect(env.KORTIX_GIT_AUTH_TOKEN).toBe('gitlab-project-token');
    expect(env.KORTIX_GITHUB_TOKEN).toBe('gitlab-project-token');
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
    expect(env.KORTIX_PROJECT_ID).toBe(PROJECT_ID);
    expect(env.KORTIX_SESSION_ID).toBeTruthy();
    expect(env.KORTIX_REPO_URL).toBe(projectRow.repoUrl);
    expect(env.KORTIX_BASE_REF).toBe('main');
    expect(env.KORTIX_LLM_TOKEN).toBeTruthy();
    expect(env.KORTIX_LLM_BASE_URL).toContain('/v1/router/llm');
    expect(env.KORTIX_GIT_AUTH_TOKEN).toBe('pat-token');
    expect(env.KORTIX_GITHUB_TOKEN).toBe('pat-token');

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
