/**
 * End-to-end contract for the per-project OAuth flow.
 *
 * Drives the full lifecycle through the HTTP routes:
 *   1. POST /oauth/openai/start  → stores flow state, returns user_code
 *   2. POST /oauth/openai/poll   → first call: pending; second call: success
 *   3. Created session injects OPENCODE_AUTH_CONTENT into the sandbox env
 *   4. DELETE /oauth/openai      → tears down the credential row
 *
 * Upstream HTTP is faked via `globalThis.fetch` so we exercise our actual
 * route handlers + DB layer without hitting auth.openai.com.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountMembers,
  projectMembers,
  projectOauthCredentials,
  projectSecrets,
  projectSessions,
  projects,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000b01';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000b02';
const PROJECT_ID = '00000000-0000-4000-a000-000000000b03';
const SESSION_ID = '00000000-0000-4000-a000-000000000b04';

let credentialRows: Array<typeof projectOauthCredentials.$inferSelect>;
let sessionRow: typeof projectSessions.$inferSelect | null;
let secretRows: Array<typeof projectSecrets.$inferSelect>;
let lastProvisionInput: {
  sandboxId: string;
  accountId: string;
  projectId: string;
  userId: string;
  provider?: string;
  extraEnvVars?: Record<string, string>;
  metadata?: Record<string, unknown>;
} | null = null;
let sandboxProvisionCalls = 0;
let branchCreateCalls = 0;
const originalEnterpriseHosts = process.env.KORTIX_GITHUB_ENTERPRISE_HOSTS;

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'OAuth Project',
  repoUrl: 'https://github.com/kortix-ai/oauth-test.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: { github: { auth_source: 'pat', full_name: 'kortix-ai/oauth-test' } },
  lastOpenedAt: null,
  createdAt: new Date('2026-05-18T00:00:00Z'),
  updatedAt: new Date('2026-05-18T00:00:00Z'),
};

function resetState() {
  credentialRows = [];
  secretRows = [];
  lastProvisionInput = null;
  sandboxProvisionCalls = 0;
  branchCreateCalls = 0;
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
    metadata: {},
    createdAt: new Date('2026-05-18T00:00:00Z'),
    updatedAt: new Date('2026-05-18T00:00:00Z'),
  };
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'oauth@example.test');
    await next();
  },
}));

// Use the real `config` module — it loads from .env which already has
// API_KEY_SECRET defined, matching the pattern in
// e2e-project-session-contract.test.ts. Mocking config would force us to
// enumerate every field used downstream (SANDBOX_VERSION, etc.).

mock.module('../projects/git', () => ({
  createRemoteSessionBranch: async () => {
    branchCreateCalls += 1;
  },
  archiveRepoSubtree: async () => undefined,
  deleteRemoteSessionBranch: async () => undefined,
  listRepoFiles: async () => [],
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
  createRepo: async () => { throw new Error('not used'); },
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

mock.module('../shared/account-limits', () => ({
  resolveAccountTier: async () => 'free',
  maxConcurrentSessionsForTier: () => 10,
  sessionLlmPolicyForTier: () => ({ limit: 60, windowMs: 60_000 }),
  clearAccountLimitCache: () => undefined,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'oauth@example.test' } } }),
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
            const data = table === projectOauthCredentials
              ? credentialRows
              : table === projectSecrets
                ? secretRows
                : [];
            Promise.resolve(data).then(resolve, reject);
          },
          orderBy: async () => {
            if (table === projectOauthCredentials) return credentialRows;
            if (table === projectSecrets) return secretRows;
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            return [];
          },
          limit: async () => {
            if (fields && Object.keys(fields).includes('activeCount')) return [{ activeCount: 0 }];
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
            if (table === projectMembers) return [];
            if (table === projectOauthCredentials) return credentialRows;
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        returning: async () => {
          if (table === projectSessions) {
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
              createdAt: new Date('2026-05-18T00:00:00Z'),
              updatedAt: values.updatedAt ?? new Date('2026-05-18T00:00:00Z'),
            };
            return [sessionRow];
          }
          return [];
        },
        onConflictDoUpdate: ({ set }: { set: any }) => ({
          returning: async () => {
            if (table === projectOauthCredentials) {
              const existingIdx = credentialRows.findIndex(
                (r) => r.projectId === values.projectId && r.providerId === values.providerId,
              );
              const now = new Date('2026-05-18T00:00:00Z');
              const row: typeof projectOauthCredentials.$inferSelect = {
                credentialId: existingIdx >= 0
                  ? credentialRows[existingIdx]!.credentialId
                  : '00000000-0000-4000-a000-000000000c01',
                projectId: values.projectId,
                providerId: values.providerId,
                refreshEnc: (set.refreshEnc ?? values.refreshEnc) as string,
                accessEnc: (set.accessEnc ?? values.accessEnc) as string,
                expires: Number(set.expires ?? values.expires),
                accountId: (set.accountId ?? values.accountId) ?? null,
                enterpriseUrl: (set.enterpriseUrl ?? values.enterpriseUrl) ?? null,
                createdBy: values.createdBy ?? null,
                createdAt: existingIdx >= 0 ? credentialRows[existingIdx]!.createdAt : now,
                updatedAt: (set.updatedAt ?? values.updatedAt) ?? now,
              };
              if (existingIdx >= 0) credentialRows[existingIdx] = row;
              else credentialRows.push(row);
              return [row];
            }
            return [];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectOauthCredentials) credentialRows = [];
        if (table === projectSecrets) secretRows = [];
      },
    }),
    update: (table: unknown) => ({
      set: (updates: Partial<typeof projectSessions.$inferSelect>) => ({
        where: () => ({
          returning: async () => {
            if (table !== projectSessions || !sessionRow) return [];
            sessionRow = {
              ...sessionRow,
              ...updates,
              updatedAt: updates.updatedAt ?? new Date('2026-05-18T00:00:00Z'),
            };
            return [sessionRow];
          },
        }),
      }),
    }),
  },
}));

// ─── Upstream OAuth fetch fake ──────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit | undefined };
const fetchCalls: FetchCall[] = [];
const fetchResponders: Array<(url: string, init?: RequestInit) => Response | null> = [];
const originalFetch = globalThis.fetch;

function fakeJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

beforeEach(() => {
  resetState();
  process.env.KORTIX_GITHUB_ENTERPRISE_HOSTS = 'company.ghe.com';
  fetchCalls.length = 0;
  fetchResponders.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });
    for (const r of fetchResponders) {
      const out = r(url, init);
      if (out) return out;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnterpriseHosts === undefined) delete process.env.KORTIX_GITHUB_ENTERPRISE_HOSTS;
  else process.env.KORTIX_GITHUB_ENTERPRISE_HOSTS = originalEnterpriseHosts;
});

describe('project OAuth e2e — ChatGPT Pro/Plus headless', () => {
  test('rejects unsupported providers at start', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/oauth/anthropic/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Unsupported');
  });

  test('start → poll(pending) → poll(success) persists encrypted credentials', async () => {
    const app = createApp();

    // First upstream call: device-auth/usercode
    fetchResponders.push((url) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return fakeJson(200, {
          device_auth_id: 'dev-e2e-1',
          user_code: 'ABCD-1234',
          interval: '5',
          expires_in: 600,
        });
      }
      return null;
    });

    const startRes = await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(startRes.status).toBe(200);
    const startBody = await startRes.json();
    expect(startBody.user_code).toBe('ABCD-1234');
    expect(startBody.verification_url).toBe('https://auth.openai.com/codex/device');
    expect(startBody.flow_id).toBeTruthy();
    expect(startBody.interval_ms).toBe(5000);

    // First poll: upstream still pending (403)
    fetchResponders.length = 0;
    fetchResponders.push((url) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        return new Response('', { status: 403 });
      }
      return null;
    });

    const pollPending = await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: startBody.flow_id }),
    });
    expect(pollPending.status).toBe(200);
    expect(await pollPending.json()).toMatchObject({ status: 'pending', next_poll_ms: 5000 });
    expect(credentialRows).toHaveLength(0);

    // Second poll: upstream returns auth code, kortix exchanges for tokens.
    const idTokenClaims = { chatgpt_account_id: 'org-e2e' };
    const idToken = `h.${Buffer.from(JSON.stringify(idTokenClaims)).toString('base64url')}.s`;
    fetchResponders.length = 0;
    fetchResponders.push((url) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        return fakeJson(200, { authorization_code: 'auth-e2e', code_verifier: 'verifier-e2e' });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        return fakeJson(200, {
          id_token: idToken,
          access_token: 'access-e2e',
          refresh_token: 'refresh-e2e',
          expires_in: 3600,
        });
      }
      return null;
    });

    const pollSuccess = await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: startBody.flow_id }),
    });
    expect(pollSuccess.status).toBe(200);
    const successBody = await pollSuccess.json();
    expect(successBody.status).toBe('success');
    expect(successBody.credential.provider_id).toBe('openai');
    expect(successBody.credential.account_id).toBe('org-e2e');

    // Encrypted at rest — plaintext tokens never appear in the row.
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].refreshEnc).not.toContain('refresh-e2e');
    expect(credentialRows[0].accessEnc).not.toContain('access-e2e');

    // Listing reports the credential without leaking tokens.
    const listRes = await app.request(`/v1/projects/${PROJECT_ID}/oauth`);
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].account_id).toBe('org-e2e');
    expect(listed.items[0].provider_id).toBe('openai');
    expect((listed.items[0] as Record<string, unknown>).refresh).toBeUndefined();
    expect((listed.items[0] as Record<string, unknown>).access).toBeUndefined();
  });

  test('poll with stale flow_id returns expired', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: 'never-existed' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'expired' });
  });

  test('DELETE clears the OAuth credential row', async () => {
    const app = createApp();

    // Seed an OAuth credential by going through start/poll.
    fetchResponders.push((url) => {
      if (url.endsWith('/deviceauth/usercode')) {
        return fakeJson(200, { device_auth_id: 'd', user_code: 'C', interval: '5' });
      }
      if (url.endsWith('/deviceauth/token')) {
        return fakeJson(200, { authorization_code: 'a', code_verifier: 'v' });
      }
      if (url.endsWith('/oauth/token')) {
        return fakeJson(200, {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
        });
      }
      return null;
    });
    const startBody = await (await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: startBody.flow_id }),
    });
    expect(credentialRows).toHaveLength(1);

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(credentialRows).toHaveLength(0);
  });
});

describe('project OAuth e2e — GitHub Copilot device-code', () => {
  test('start with enterprise_url routes to the GHE host', async () => {
    const app = createApp();
    fetchResponders.push((url) => {
      if (url === 'https://company.ghe.com/login/device/code') {
        return fakeJson(200, {
          verification_uri: 'https://company.ghe.com/login/device',
          user_code: 'GHE-CODE',
          device_code: 'devcode-ent',
          interval: 5,
        });
      }
      return null;
    });
    const startRes = await app.request(`/v1/projects/${PROJECT_ID}/oauth/github-copilot/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enterprise_url: 'https://company.ghe.com' }),
    });
    expect(startRes.status).toBe(200);
    const body = await startRes.json();
    expect(body.user_code).toBe('GHE-CODE');
    expect(body.verification_url).toBe('https://company.ghe.com/login/device');
  });

  test('poll(slow_down) bumps interval and stays in pending', async () => {
    const app = createApp();
    fetchResponders.push((url) => {
      if (url.endsWith('/device/code')) {
        return fakeJson(200, {
          verification_uri: 'https://github.com/login/device',
          user_code: 'X',
          device_code: 'd',
          interval: 5,
        });
      }
      return null;
    });
    const startBody = await (await app.request(`/v1/projects/${PROJECT_ID}/oauth/github-copilot/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).json();

    fetchResponders.length = 0;
    fetchResponders.push(() => fakeJson(200, { error: 'slow_down', interval: 12 }));

    const pollRes = await app.request(`/v1/projects/${PROJECT_ID}/oauth/github-copilot/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: startBody.flow_id }),
    });
    expect(pollRes.status).toBe(200);
    expect(await pollRes.json()).toEqual({ status: 'pending', next_poll_ms: 12_000 });
  });

  test('successful Copilot poll stores expires=0 (never expires) and any enterprise URL', async () => {
    const app = createApp();
    fetchResponders.push((url) => {
      if (url.endsWith('/device/code')) {
        return fakeJson(200, {
          verification_uri: 'https://company.ghe.com/login/device',
          user_code: 'X',
          device_code: 'd',
          interval: 5,
        });
      }
      if (url.endsWith('/oauth/access_token')) {
        return fakeJson(200, { access_token: 'gho_test_token' });
      }
      return null;
    });
    const startBody = await (await app.request(`/v1/projects/${PROJECT_ID}/oauth/github-copilot/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enterprise_url: 'company.ghe.com' }),
    })).json();
    const pollBody = await (await app.request(`/v1/projects/${PROJECT_ID}/oauth/github-copilot/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: startBody.flow_id }),
    })).json();

    expect(pollBody.status).toBe('success');
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].expires).toBe(0);
    expect(credentialRows[0].enterpriseUrl).toBe('company.ghe.com');
  });
});

describe('project OAuth e2e — sandbox env injection', () => {
  test('OPENCODE_AUTH_CONTENT is bundled into extraEnvVars at session create', async () => {
    const app = createApp();

    // Seed both providers.
    fetchResponders.push((url) => {
      if (url.endsWith('/deviceauth/usercode')) {
        return fakeJson(200, { device_auth_id: 'd', user_code: 'C', interval: '5' });
      }
      if (url.endsWith('/deviceauth/token')) {
        return fakeJson(200, { authorization_code: 'a', code_verifier: 'v' });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        return fakeJson(200, {
          id_token: `h.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'org-sandbox' })).toString('base64url')}.s`,
          access_token: 'oa-access',
          refresh_token: 'oa-refresh',
          expires_in: 3600,
        });
      }
      if (url.endsWith('/device/code')) {
        return fakeJson(200, {
          verification_uri: 'https://github.com/login/device',
          user_code: 'X',
          device_code: 'gh-d',
          interval: 5,
        });
      }
      if (url.endsWith('/login/oauth/access_token')) {
        return fakeJson(200, { access_token: 'gho_copilot' });
      }
      return null;
    });

    // Drive both flows to completion.
    const openaiStart = await (await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: openaiStart.flow_id }),
    });

    const copilotStart = await (await app.request(`/v1/projects/${PROJECT_ID}/oauth/github-copilot/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    await app.request(`/v1/projects/${PROJECT_ID}/oauth/github-copilot/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: copilotStart.flow_id }),
    });

    expect(credentialRows).toHaveLength(2);

    // Create a session — OPENCODE_AUTH_CONTENT should land in extraEnvVars.
    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);

    // Flush the fire-and-forget provisionSessionSandbox IIFE.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sandboxProvisionCalls).toBe(1);

    const env = lastProvisionInput?.extraEnvVars ?? {};
    expect(env.OPENCODE_AUTH_CONTENT).toBeDefined();

    // Shape matches opencode's auth/index.ts schema exactly.
    const parsed = JSON.parse(env.OPENCODE_AUTH_CONTENT!) as Record<string, Record<string, unknown>>;
    expect(parsed.openai).toEqual({
      type: 'oauth',
      refresh: 'oa-refresh',
      access: 'oa-access',
      expires: expect.any(Number),
      accountId: 'org-sandbox',
    });
    expect(parsed['github-copilot']).toEqual({
      type: 'oauth',
      refresh: 'gho_copilot',
      access: 'gho_copilot',
      expires: 0,
    });

    // The platform KORTIX_* envelope is still present — OPENCODE_AUTH_CONTENT
    // doesn't crowd it out.
    expect(env.KORTIX_PROJECT_ID).toBe(PROJECT_ID);
    expect(env.KORTIX_SESSION_ID).toBeTruthy();
  });

  test('OPENCODE_AUTH_CONTENT is omitted entirely when the project has no OAuth credentials', async () => {
    const app = createApp();
    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const env = lastProvisionInput?.extraEnvVars ?? {};
    expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(env.KORTIX_PROJECT_ID).toBe(PROJECT_ID);
  });

  test('expiring OpenAI tokens are refreshed at session boot before being emitted', async () => {
    const app = createApp();

    // Seed an OpenAI credential that's about to expire.
    fetchResponders.push((url) => {
      if (url.endsWith('/deviceauth/usercode')) {
        return fakeJson(200, { device_auth_id: 'd', user_code: 'C', interval: '5' });
      }
      if (url.endsWith('/deviceauth/token')) {
        return fakeJson(200, { authorization_code: 'a', code_verifier: 'v' });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        return fakeJson(200, {
          id_token: `h.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'org-1' })).toString('base64url')}.s`,
          access_token: 'access-stale',
          refresh_token: 'refresh-1',
          // ~30s before expiry — well inside the 5-min refresh lead.
          expires_in: 30,
        });
      }
      return null;
    });

    const openaiStart = await (await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    await app.request(`/v1/projects/${PROJECT_ID}/oauth/openai/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: openaiStart.flow_id }),
    });
    expect(credentialRows[0].expires).toBeLessThan(Date.now() + 60_000);

    // Now stub the refresh endpoint to return a fresh token.
    fetchResponders.length = 0;
    fetchResponders.push((url, init) => {
      if (url === 'https://auth.openai.com/oauth/token') {
        const body = new URLSearchParams(init?.body as string);
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('refresh-1');
        return fakeJson(200, {
          access_token: 'access-fresh',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        });
      }
      return null;
    });

    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const env = lastProvisionInput?.extraEnvVars ?? {};
    const parsed = JSON.parse(env.OPENCODE_AUTH_CONTENT!) as Record<string, Record<string, unknown>>;
    expect(parsed.openai.access).toBe('access-fresh');
    expect(parsed.openai.refresh).toBe('refresh-2');
    // accountId is preserved across refresh.
    expect(parsed.openai.accountId).toBe('org-1');
    // And the new tokens are persisted so the next boot doesn't have to refresh again.
    expect(credentialRows[0].expires).toBeGreaterThan(Date.now() + 3000_000);
  });
});
