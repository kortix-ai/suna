import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, projectMembers, projectSecrets, projectSessions, projects } from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const SESSION_ID = '00000000-0000-4000-a000-000000000301';

let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let activeSessionCount = 0;
let sessionRow: typeof projectSessions.$inferSelect | null;
let secretRows: Array<typeof projectSecrets.$inferSelect>;

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Contract Project',
  repoUrl: 'https://github.com/kortix-ai/contract-project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function resetState() {
  branchCreateCalls = 0;
  sandboxProvisionCalls = 0;
  activeSessionCount = 0;
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
  deleteRemoteSessionBranch: async () => undefined,
  listRepoFiles: async () => [],
  loadProjectConfig: async () => ({}),
  readRepoFile: async () => '',
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  diffStat: async () => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  getFileAtRef: async () => null,
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
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
  provisionSessionSandbox: async () => {
    sandboxProvisionCalls += 1;
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
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

const { projectsApp, buildProjectConnectorBaseUrl, buildProjectLlmBaseUrl } = await import('../projects/index');

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

describe('project session API contract', () => {
  beforeEach(() => resetState());

  test('builds the session LLM router URL from common API URL shapes', () => {
    expect(buildProjectLlmBaseUrl('https://api.kortix.com')).toBe('https://api.kortix.com/v1/router/llm');
    expect(buildProjectLlmBaseUrl('https://api.kortix.com/v1')).toBe('https://api.kortix.com/v1/router/llm');
    expect(buildProjectLlmBaseUrl('https://api.kortix.com/v1/router')).toBe('https://api.kortix.com/v1/router/llm');
    expect(buildProjectLlmBaseUrl('https://api.kortix.com/v1/router/')).toBe('https://api.kortix.com/v1/router/llm');
  });

  test('builds the session connector router URL from common API URL shapes', () => {
    expect(buildProjectConnectorBaseUrl('https://api.kortix.com')).toBe('https://api.kortix.com/v1/router/connectors');
    expect(buildProjectConnectorBaseUrl('https://api.kortix.com/v1')).toBe('https://api.kortix.com/v1/router/connectors');
    expect(buildProjectConnectorBaseUrl('https://api.kortix.com/v1/router')).toBe('https://api.kortix.com/v1/router/connectors');
    expect(buildProjectConnectorBaseUrl('https://api.kortix.com/v1/router/')).toBe('https://api.kortix.com/v1/router/connectors');
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
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('OPENAI_API_KEY');
    expect(listed[0].value).toBeUndefined();
    expect(listed[0].value_enc).toBeUndefined();

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets/openai_api_key`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(secretRows).toHaveLength(0);
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

  test('creates a session with the required id, branch, and sandbox invariant', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'local_docker',
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
    expect(body.sandbox_provider).toBe('local_docker');
    expect(body.status).toBe('provisioning');
    expect(body.name).toBe('Contract session');
    expect(branchCreateCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 0));
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
      body: JSON.stringify({ provider: 'local_docker' }),
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
