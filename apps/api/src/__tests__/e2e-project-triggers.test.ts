import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll } from './helpers/iam-mocks';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountGithubInstallations,
  accountMembers,
  projectMembers,
  projectSecrets,
  projectSessions,
  projectTriggerRuntime,
  projects,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const MANIFEST_PATH = 'kortix.toml';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

// ─── In-memory git mock ─────────────────────────────────────────────────────
// Every git read/write goes through this map so a test's "commitFile" is
// observable by the very next "listRepoFiles" / "readRepoFile" call. That
// mirrors the post-write `invalidateProjectMirror` behavior in production.

let repoFiles: Map<string, string>;
let commitCalls: Array<{ path: string; message: string }>;
let deleteCalls: Array<{ path: string; message: string }>;
let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let lastProvisionEnv: Record<string, string> | null = null;
let runtimeRows: Array<{ projectId: string; slug: string; lastFiredAt: Date | null; updatedAt: Date }>;
let sessionRows: Array<typeof projectSessions.$inferSelect>;
let activeSessionCount = 0;
let provisioningSessionCount = 0;
let secretRows: Array<typeof projectSecrets.$inferSelect>;

function setTestAuth(userId = USER_ID, userEmail = 'triggers@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}

function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'triggers@example.test' };
}

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Trigger Project',
  repoUrl: 'https://github.com/kortix-ai/trigger-project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function resetState() {
  setTestAuth();
  repoFiles = new Map();
  commitCalls = [];
  deleteCalls = [];
  branchCreateCalls = 0;
  sandboxProvisionCalls = 0;
  lastProvisionEnv = null;
  runtimeRows = [];
  sessionRows = [];
  activeSessionCount = 0;
  provisioningSessionCount = 0;
  secretRows = [];
  secretValues.clear();
}

function sign(rawBody: string, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

mockIamEngineAllowAll();

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
  createRemoteSessionBranch: async () => {
    branchCreateCalls += 1;
  },
  archiveRepoSubtree: async () => undefined,
  listRepoFiles: async (_project: any, _ref: string, path?: string) => {
    const prefix = (path ?? '').replace(/\/$/, '');
    const entries = Array.from(repoFiles.keys())
      .filter((p) => !prefix || p.startsWith(prefix + '/') || p === prefix)
      .map((p) => ({ path: p, type: 'file' as const, size: null }));
    return entries;
  },
  readRepoFile: async (_project: any, path: string) => {
    const content = repoFiles.get(path);
    if (content === undefined) throw new Error(`Not found: ${path}`);
    return content;
  },
  loadProjectConfig: async () => ({ env: { required: [], optional: [] } }),
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
  getMergeBase: async () => 'a'.repeat(40),
  materializeRepoContext: async () => '/tmp/fake-snapshot-context',
}));

mock.module("../snapshots/builder", () => ({
  ensureSandboxImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
  deleteSandboxImage: async () => ({ deleted: false, snapshotName: "kortix-default-test", slug: "default" }),
  listSnapshotBuilds: async () => [],
  reconcileStaleBuilds: async () => {},
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: "default", spec: {}, isDefault: true }),
  kickPreBuild: () => {},
  kickProjectTemplatePrebuilds: () => {},
  resolveCommitSha: async () => "a".repeat(40),
  DEFAULT_SANDBOX_SLUG: "default",
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  verifyGitHubAppInstallStatePayload: (state: string) => ({
    accountId: state,
    nonce: 'test-nonce',
    issuedAt: Math.floor(Date.now() / 1000),
  }),
  getGitHubPatAuthContext: () => ({ token: 'pat-token', source: 'pat', owner: 'kortix-org' }),
  commitFile: async (opts: { path: string; content: string; message: string }) => {
    repoFiles.set(opts.path, opts.content);
    commitCalls.push({ path: opts.path, message: opts.message });
  },
  createInstallationToken: async () => ({ token: 'installation-token' }),
  createRepo: async () => {
    throw new Error('not used');
  },
  deleteRepo: async () => undefined,
  addCollaborator: async () => undefined,
  getBranchCommitSha: async () => 'a'.repeat(40),
  createBranchRef: async () => undefined,
  parseGitHubRepoUrl: () => ({ owner: 'kortix-org', repo: 'trigger-project' }),
  deleteFile: async (opts: { path: string; message: string }) => {
    repoFiles.delete(opts.path);
    deleteCalls.push({ path: opts.path, message: opts.message });
  },
  getFileSha: async (opts: { path: string }) => {
    return repoFiles.has(opts.path) ? `sha-${opts.path}` : null;
  },
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: {},
  }),
  getRepo: async () => ({
    id: 1,
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
    lastProvisionEnv = input.extraEnvVars;
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'triggers@example.test' } } }),
      },
    },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'pro' }),
  // Trigger fire spawns a real session, which runs the billing gate. Return a
  // billing-active account (live sub + ample balance) so the gate passes.
  getCreditAccount: async () => ({
    accountId: ACCOUNT_ID,
    balance: 1_000_000,
    billingModel: 'credits',
    stripeSubscriptionId: 'sub_test',
    stripeSubscriptionStatus: 'active',
  }),
  getCreditBalance: async () => ({ balance: 1_000_000, granted: 1_000_000, used: 0 }),
  updateCreditAccount: async () => {},
}));

// Stub secrets so webhook tests can resolve the trigger's signing secret.
// Tests can read/override `secretValues` to drive specific behaviors.
const secretValues = new Map<string, string>();
mock.module('../projects/secrets', () => ({
  encryptProjectSecret: (_p: string, v: string) => `enc:${v}`,
  decryptProjectSecret: (_p: string, v: string) => v.replace(/^enc:/, ''),
  isValidSecretName: (n: string) => /^[A-Z_][A-Z0-9_]*$/.test(n),
  listProjectSecrets: async () => ({}),
  listProjectSecretsSnapshotForUser: async () => ({ env: {}, names: [], revision: 'empty' }),
  getProjectSecretValue: async (_projectId: string, name: string) =>
    secretValues.get(name) ?? null,
}));

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const result: any[] & { orderBy?: () => Promise<any[]>; limit?: () => Promise<any[]> } = [];
          result.orderBy = async () => {
            if (table === projectSessions) return sessionRows;
            return [];
          };
          result.limit = async () => {
            if (fields && Object.keys(fields).includes('activeCount')) {
              return [{ activeCount: activeSessionCount }];
            }
            if (fields && Object.keys(fields).includes('provisioningCount')) {
              return [{ provisioningCount: provisioningSessionCount }];
            }
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner', userId: USER_ID }];
            if (table === accountGithubInstallations) return [];
            if (table === projectMembers) return [];
            return [];
          };
          // Some callers `await` directly without orderBy/limit (e.g. select
          // from runtime table). Make `result` a thenable that resolves to
          // the runtime rows for that table when iterated.
          (result as any).then = (resolve: (rows: any[]) => unknown) => {
            if (table === projectTriggerRuntime) resolve(runtimeRows.filter((r) => r.projectId === PROJECT_ID));
            else if (table === projectSecrets) resolve(secretRows);
            else resolve([]);
          };
          return result;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        returning: async () => {
          const now = new Date('2026-01-02T00:00:00Z');
          if (table === projectSessions) {
            const row: typeof projectSessions.$inferSelect = {
              sessionId: values.sessionId,
              accountId: values.accountId,
              projectId: values.projectId,
              branchName: values.branchName,
              baseRef: values.baseRef,
              sandboxProvider: values.sandboxProvider,
              sandboxId: values.sandboxId ?? null,
              sandboxUrl: null,
              opencodeSessionId: null,
              agentName: values.agentName ?? 'default',
              status: values.status ?? 'provisioning',
              error: null,
              createdBy: values.createdBy ?? null,
              visibility: values.visibility ?? 'private',
              metadata: values.metadata ?? {},
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            sessionRows.push(row);
            return [row];
          }
          return [];
        },
        onConflictDoUpdate: ({ set }: { set: any }) => {
          // Production code awaits this directly without calling .returning()
          // (`db.insert(...).values(...).onConflictDoUpdate({...})`). Make the
          // returned object both thenable AND `.returning()`-able so both
          // shapes work.
          const apply = (): any[] => {
            if (table === projectTriggerRuntime) {
              const idx = runtimeRows.findIndex(
                (r) => r.projectId === values.projectId && r.slug === values.slug,
              );
              const next = {
                projectId: values.projectId,
                slug: values.slug,
                lastFiredAt: (set.lastFiredAt ?? values.lastFiredAt) as Date | null,
                updatedAt: (set.updatedAt ?? values.updatedAt ?? new Date()) as Date,
              };
              if (idx >= 0) runtimeRows[idx] = next;
              else runtimeRows.push(next);
              return [next];
            }
            return [];
          };
          return {
            returning: async () => apply(),
            then: (resolve: (v: any) => unknown) => resolve(apply()),
          };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [],
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectTriggerRuntime) runtimeRows = [];
      },
    }),
  },
}));

process.env.ALLOWED_SANDBOX_PROVIDERS = 'local_docker';
process.env.DOCKER_HOST ||= 'unix:///var/run/docker.sock';
process.env.KORTIX_WARM_POOL_SIZE = '0';
process.env.KORTIX_TRIGGER_SCHEDULER_ENABLED = 'false';
process.env.KORTIX_APPS_EXPERIMENTAL = 'false';

const { projectsApp, projectWebhooksApp, runProjectTriggerSweep } = await import('../projects/index');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.route('/v1/webhooks', projectWebhooksApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

// ─── Manifest seeding helpers ──────────────────────────────────────────────
// All trigger config lives in `kortix.toml` now. Tests seed manifest content
// directly into the in-memory repo — same shape the CRUD handlers read/write.

const MANIFEST_PREAMBLE = `kortix_version = 1\n[project]\nname = "Trigger Project"\n`;

function seedManifest(...triggerBlocks: string[]) {
  const body = triggerBlocks.length === 0
    ? MANIFEST_PREAMBLE
    : `${MANIFEST_PREAMBLE}\n${triggerBlocks.join('\n\n')}\n`;
  repoFiles.set(MANIFEST_PATH, body);
}

/** Build a `[[triggers]]` block for a cron trigger. */
function cronEntry(opts: {
  slug: string;
  name?: string;
  cron: string;
  timezone?: string;
  agent?: string;
  enabled?: boolean;
  prompt: string;
}): string {
  const lines = ['[[triggers]]', `slug = "${opts.slug}"`];
  if (opts.name !== undefined) lines.push(`name = "${opts.name}"`);
  lines.push('type = "cron"');
  if (opts.agent !== undefined) lines.push(`agent = "${opts.agent}"`);
  if (opts.enabled !== undefined) lines.push(`enabled = ${opts.enabled}`);
  lines.push(`cron = "${opts.cron}"`);
  if (opts.timezone !== undefined) lines.push(`timezone = "${opts.timezone}"`);
  lines.push(`prompt = ${JSON.stringify(opts.prompt)}`);
  return lines.join('\n');
}

/** Build a `[[triggers]]` block for a webhook trigger. */
function webhookEntry(opts: {
  slug: string;
  name?: string;
  secretEnv: string;
  agent?: string;
  enabled?: boolean;
  prompt: string;
}): string {
  const lines = ['[[triggers]]', `slug = "${opts.slug}"`];
  if (opts.name !== undefined) lines.push(`name = "${opts.name}"`);
  lines.push('type = "webhook"');
  if (opts.agent !== undefined) lines.push(`agent = "${opts.agent}"`);
  if (opts.enabled !== undefined) lines.push(`enabled = ${opts.enabled}`);
  lines.push(`secret_env = "${opts.secretEnv}"`);
  lines.push(`prompt = ${JSON.stringify(opts.prompt)}`);
  return lines.join('\n');
}

describe('git-backed triggers — CRUD', () => {
  beforeEach(() => resetState());

  test('POST /triggers commits a new cron trigger into kortix.toml and returns the listing', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily Digest',
        type: 'cron',
        cron: '0 0 9 * * 1-5',
        timezone: 'UTC',
        prompt_template: 'Pull the deploy logs.',
      }),
    });

    expect(res.status).toBe(201);
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]!.path).toBe(MANIFEST_PATH);
    expect(commitCalls[0]!.message).toBe('chore: add trigger daily-digest');

    // Manifest content reflects the new trigger as a [[triggers]] entry.
    const written = repoFiles.get(MANIFEST_PATH)!;
    expect(written).toContain('kortix_version = 1');
    expect(written).toContain('[[triggers]]');
    expect(written).toContain('slug = "daily-digest"');
    expect(written).toContain('name = "Daily Digest"');
    expect(written).toContain('type = "cron"');
    expect(written).toContain('cron = "0 0 9 * * 1-5"');
    expect(written).toContain('Pull the deploy logs.');

    const body = await res.json();
    expect(body.triggers).toHaveLength(1);
    expect(body.triggers[0]).toMatchObject({
      slug: 'daily-digest',
      name: 'Daily Digest',
      type: 'cron',
      cron: '0 0 9 * * 1-5',
      enabled: true,
      agent: 'default',
    });
  });

  test('POST /triggers commits a webhook trigger and exposes the URL on listing', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Slack hook',
        type: 'webhook',
        secret_env: 'SLACK_WEBHOOK_SECRET',
        prompt_template: 'New {{ message.source }} event',
      }),
    });
    expect(res.status).toBe(201);
    expect(commitCalls[0]!.path).toBe(MANIFEST_PATH);

    const body = await res.json();
    expect(body.triggers[0]).toMatchObject({
      slug: 'slack-hook',
      type: 'webhook',
      secret_env: 'SLACK_WEBHOOK_SECRET',
    });
    expect(body.triggers[0].webhook_url).toContain(`/v1/webhooks/projects/${PROJECT_ID}/slack-hook`);
  });

  test('POST /triggers rejects duplicate slugs', async () => {
    seedManifest(cronEntry({
      slug: 'daily-digest',
      name: 'Daily Digest',
      cron: '0 0 9 * * 1-5',
      prompt: 'existing prompt',
    }));
    const app = createApp();

    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily Digest',
        type: 'cron',
        cron: '0 0 9 * * 1-5',
        prompt_template: 'duplicate',
      }),
    });
    expect(res.status).toBe(409);
    expect(commitCalls).toHaveLength(0);
  });

  test('POST /triggers rejects missing required fields with a concrete error', async () => {
    const app = createApp();
    const cases = [
      { body: { type: 'cron', cron: '* * * * * *', prompt_template: 'x' }, expect: /name is required/ },
      { body: { name: 'X', type: 'cron', prompt_template: 'x' }, expect: /cron triggers must declare/ },
      { body: { name: 'X', type: 'webhook', prompt_template: 'x' }, expect: /secret_env/ },
      { body: { name: 'X', prompt_template: 'x' }, expect: /type must be/ },
    ];
    for (const c of cases) {
      const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(c.expect);
    }
    expect(commitCalls).toHaveLength(0);
  });

  test('POST /triggers ignores agent_name in favor of agent', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Agent alias',
        type: 'cron',
        cron: '* * * * * *',
        prompt_template: 'x',
        agent_name: 'reviewer',
      }),
    });
    expect(res.status).toBe(201);
    const written = repoFiles.get(MANIFEST_PATH)!;
    expect(written).not.toContain('agent = "reviewer"');
  });

  test('GET /triggers lists every entry plus runtime last_fired_at', async () => {
    seedManifest(
      cronEntry({ slug: 'one', name: 'One', cron: '* * * * * *', prompt: 'body' }),
      webhookEntry({ slug: 'two', name: 'Two', secretEnv: 'TWO_SECRET', prompt: 'body' }),
    );
    runtimeRows.push({
      projectId: PROJECT_ID,
      slug: 'one',
      lastFiredAt: new Date('2026-01-03T12:00:00Z'),
      updatedAt: new Date('2026-01-03T12:00:00Z'),
    });

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.triggers).toHaveLength(2);
    const oneRow = body.triggers.find((t: any) => t.slug === 'one')!;
    expect(oneRow.last_fired_at).toBe('2026-01-03T12:00:00.000Z');
    expect(body.errors).toEqual([]);
  });

  test('GET /triggers surfaces parse errors without dropping good triggers', async () => {
    // "broken" entry is missing the required cron expression.
    seedManifest(
      cronEntry({ slug: 'good', name: 'Good', cron: '* * * * * *', prompt: 'body' }),
      ['[[triggers]]', 'slug = "broken"', 'type = "cron"', 'prompt = "no cron field here"'].join('\n'),
    );

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.triggers).toHaveLength(1);
    expect(body.triggers[0].slug).toBe('good');
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].slug).toBe('broken');
  });

  test('PATCH /triggers/:slug rewrites the manifest entry with the merged spec', async () => {
    seedManifest(cronEntry({
      slug: 'one',
      name: 'Old name',
      agent: 'default',
      enabled: true,
      cron: '0 */15 * * * *',
      timezone: 'UTC',
      prompt: 'old prompt',
    }));

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers/one`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New name', enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]!.path).toBe(MANIFEST_PATH);
    expect(commitCalls[0]!.message).toBe('chore: update trigger one');

    const updated = repoFiles.get(MANIFEST_PATH)!;
    expect(updated).toContain('name = "New name"');
    expect(updated).toContain('enabled = false');
    // Unchanged fields preserved from the existing spec.
    expect(updated).toContain('cron = "0 */15 * * * *"');
    expect(updated).toContain('old prompt');
  });

  test('PATCH /triggers/:slug returns 404 when the slug is not in the manifest', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers/ghost`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
    expect(commitCalls).toHaveLength(0);
  });

  test('DELETE /triggers/:slug commits a manifest revision with the entry removed', async () => {
    seedManifest(
      cronEntry({ slug: 'one', name: 'One', cron: '* * * * * *', prompt: 'body' }),
      cronEntry({ slug: 'two', name: 'Two', cron: '* * * * * *', prompt: 'body' }),
    );
    const app = createApp();

    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers/one`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(deleteCalls).toHaveLength(0);
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]!.path).toBe(MANIFEST_PATH);
    expect(commitCalls[0]!.message).toBe('chore: delete trigger one');

    // The manifest still exists, just without the deleted entry.
    const updated = repoFiles.get(MANIFEST_PATH)!;
    expect(updated).not.toContain('slug = "one"');
    expect(updated).toContain('slug = "two"');
  });

  test('DELETE /triggers/:slug returns 404 when the entry is already gone', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers/ghost`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(deleteCalls).toHaveLength(0);
    expect(commitCalls).toHaveLength(0);
  });
});

describe('git-backed triggers — runtime fire paths', () => {
  beforeEach(() => resetState());

  test('manual fire spawns a session with the rendered prompt', async () => {
    seedManifest(cronEntry({
      slug: 'daily',
      name: 'Daily',
      cron: '* * * * * *',
      prompt: 'Run at {{ fired_at }}',
    }));

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers/daily/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('fired');
    expect(body.session_id).toBeTruthy();
    expect(branchCreateCalls).toBe(1);

    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toMatch(/Run at \d{4}-\d{2}-\d{2}T/);
    // Runtime row was upserted with last_fired_at.
    expect(runtimeRows).toHaveLength(1);
    expect(runtimeRows[0]!.slug).toBe('daily');
    expect(runtimeRows[0]!.lastFiredAt).toBeTruthy();
  });

  test('cron sweep fires due git-backed triggers', async () => {
    seedManifest(cronEntry({
      slug: 'sweep',
      name: 'Sweep',
      cron: '* * * * * *',
      prompt: 'Sweep run',
    }));

    const result = await runProjectTriggerSweep(new Date('2026-01-01T00:00:30Z'));
    expect(result).toMatchObject({ scanned: 1, fired: 1, failed: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toBe('Sweep run');
  });

  test('webhook fires verify the HMAC signature and reject impostors', async () => {
    seedManifest(webhookEntry({
      slug: 'hook',
      name: 'Hook',
      secretEnv: 'HOOK_SECRET',
      prompt: 'New {{ body.action }}',
    }));
    secretValues.set('HOOK_SECRET', 'shhh');
    const app = createApp();

    const rawBody = JSON.stringify({ action: 'opened' });
    const missing = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    expect(missing.status).toBe(401);
    expect(sandboxProvisionCalls).toBe(0);

    const wrong = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'wrong-secret'),
      },
      body: rawBody,
    });
    expect(wrong.status).toBe(401);
  });

  test('webhook fires with a valid HMAC spawn a session', async () => {
    seedManifest(webhookEntry({
      slug: 'hook',
      name: 'Hook',
      secretEnv: 'HOOK_SECRET',
      prompt: 'New {{ body.action }}',
    }));
    secretValues.set('HOOK_SECRET', 'shhh');
    const app = createApp();

    const rawBody = JSON.stringify({ action: 'opened' });
    const res = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'shhh'),
      },
      body: rawBody,
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('fired');
    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toBe('New opened');
  });
});
