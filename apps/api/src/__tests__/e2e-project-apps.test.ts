/**
 * E2E for `[[apps]]` CRUD + deploy routes mounted at
 * /v1/projects/:projectId/apps.
 *
 * Mirrors e2e-project-triggers.test.ts: in-memory repo file map +
 * in-memory db mock + stubbed fetch for Freestyle. Every accepted
 * `[[apps]]` config shape is exercised (the user explicitly asked).
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountMembers,
  deployments,
  projectMembers,
  projects,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const MANIFEST_PATH = 'kortix.toml';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

// ─── In-memory state ────────────────────────────────────────────────────────

let repoFiles: Map<string, string>;
let commitCalls: Array<{ path: string; message: string; content: string }>;
let deploymentRows: Array<typeof deployments.$inferSelect>;

function setTestAuth(userId = USER_ID, userEmail = 'apps@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}

function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'apps@example.test' };
}

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Apps Project',
  repoUrl: 'https://github.com/kortix-ai/apps-project.git',
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
  deploymentRows = [];
  freestyleCalls.length = 0;
  freestyleResponse = {
    ok: true,
    status: 200,
    json: async () => ({ deploymentId: `fst-${Date.now()}` }),
  };
}

// ─── Stub Freestyle fetch ───────────────────────────────────────────────────

const freestyleCalls: Array<{ url: string; method: string; body: unknown }> = [];
let freestyleResponse: { ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string> } = {
  ok: true,
  status: 200,
  json: async () => ({ deploymentId: 'fst-stub' }),
};

const originalFetch = globalThis.fetch;
// Intercept only api.freestyle.sh; let everything else pass through.
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (typeof url === 'string' && url.includes('freestyle.sh')) {
    let body: unknown = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { /* ignore */ }
    freestyleCalls.push({ url, method: init?.method ?? 'GET', body });
    return {
      ok: freestyleResponse.ok,
      status: freestyleResponse.status,
      statusText: freestyleResponse.ok ? 'OK' : 'Error',
      json: freestyleResponse.json,
      text: freestyleResponse.text ?? (async () => JSON.stringify(await freestyleResponse.json())),
    } as unknown as Response;
  }
  // Sandbox secret fetches (sandbox:8000 / localhost:PORT/env/...) — return 404
  // so the provider falls back to env.
  if (typeof url === 'string' && /\/env\//.test(url)) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }
  return originalFetch(input, init);
}) as typeof fetch;

// Make sure the adapter sees a non-empty API key so it actually hits the
// stubbed fetch instead of bailing with "key not configured".
process.env.FREESTYLE_API_KEY = 'test-key';
// [[apps]] is experimental + off by default. The test suite intentionally
// flips it on so every route below can be exercised.
process.env.KORTIX_APPS_EXPERIMENTAL = 'true';

// ─── Mock modules ───────────────────────────────────────────────────────────

mockIamEngineAllowAll();

mockIamMembershipSyncNoop();

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    await next();
  },
  combinedAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    await next();
  },
}));

mock.module('../projects/git', () => ({
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  createRemoteSessionBranch: async () => {},
  archiveRepoSubtree: async () => undefined,
  listRepoFiles: async () => [],
  readRepoFile: async (_p: any, path: string) => {
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
}));

// Short-circuit the snapshot builder so it doesn't try to resolve git
// helpers we haven't mocked. This test doesn't exercise snapshot builds.
mock.module('../snapshots/builder', () => ({
  ensureBuildForLatestCommit: async () => ({ status: 'started', commitSha: 'a'.repeat(40) }),
  getLatestReadySnapshot: async () => null,
  listSnapshotsForProject: async () => [],
  buildSnapshotForCommit: async () => ({ daytonaName: '', commitSha: '', contentHash: '', built: false }),
  pruneOldSnapshots: async () => ({ deletedRows: 0, deletedDaytonaSnapshots: 0 }),
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => '',
  verifyGitHubAppInstallState: (state: string) => state,
  verifyGitHubAppInstallStatePayload: (state: string) => ({
    accountId: state,
    nonce: 'test-nonce',
    issuedAt: Math.floor(Date.now() / 1000),
  }),
  getGitHubPatAuthContext: () => ({ token: 'pat-token', source: 'pat', owner: 'kortix-org' }),
  commitFile: async (opts: { path: string; content: string; message: string }) => {
    repoFiles.set(opts.path, opts.content);
    commitCalls.push({ path: opts.path, message: opts.message, content: opts.content });
  },
  createInstallationToken: async () => ({ token: 't' }),
  createRepo: async () => { throw new Error('not used'); },
  deleteFile: async () => {},
  getFileSha: async (opts: { path: string }) => (repoFiles.has(opts.path) ? `sha-${opts.path}` : null),
  getGitHubAppInstallation: async () => ({ account: { login: 'x', type: 'Organization' }, repository_selection: 'all', permissions: {} }),
  isGithubAppConfigured: () => false,
  isGithubPatConfigured: () => true,
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async () => {},
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'apps@example.test' } } }),
      },
    },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'free' }),
}));

mock.module('../projects/secrets', () => ({
  encryptProjectSecret: (_p: string, v: string) => `enc:${v}`,
  decryptProjectSecret: (_p: string, v: string) => v.replace(/^enc:/, ''),
  isValidSecretName: (n: string) => /^[A-Z_][A-Z0-9_]*$/.test(n),
  listProjectSecrets: async () => ({}),
  getProjectSecretValue: async () => null,
}));

mock.module('../shared/db', () => ({
  db: {
    select: (_fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (_clause?: unknown) => {
          const result: any = [];
          result.orderBy = () => {
            const r: any[] = [];
            (r as any).limit = async () => {
              if (table === deployments) {
                // Latest by createdAt — newest first.
                return deploymentRows
                  .slice()
                  .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
                  .slice(0, 1);
              }
              return [];
            };
            return r;
          };
          result.limit = async () => {
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner', userId: USER_ID }];
            if (table === projectMembers) return [];
            return [];
          };
          (result as any).then = (resolve: (rows: any[]) => unknown) => {
            if (table === projects) resolve([projectRow]);
            else resolve([]);
          };
          return result;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => {
        if (table === deployments) {
          const now = new Date();
          const row: typeof deployments.$inferSelect = {
            deploymentId: `dep-${deploymentRows.length + 1}`,
            accountId: values.accountId,
            sandboxId: null,
            projectId: values.projectId ?? null,
            appSlug: values.appSlug ?? null,
            provider: values.provider ?? null,
            freestyleId: values.freestyleId ?? null,
            status: values.status ?? 'pending',
            sourceType: values.sourceType,
            sourceRef: values.sourceRef ?? null,
            framework: values.framework ?? null,
            domains: values.domains ?? [],
            liveUrl: values.liveUrl ?? null,
            envVars: values.envVars ?? {},
            buildConfig: values.buildConfig ?? null,
            entrypoint: values.entrypoint ?? null,
            error: values.error ?? null,
            version: values.version ?? 1,
            metadata: values.metadata ?? {},
            createdAt: now,
            updatedAt: now,
          };
          deploymentRows.push(row);
          // Pretend chain — bare insert is `await`-able.
          return Promise.resolve();
        }
        return {
          returning: async () => [],
          then: (resolve: (v: any) => unknown) => resolve([]),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            if (table === deployments) {
              for (const row of deploymentRows) {
                Object.assign(row, patch);
              }
              return deploymentRows.slice(-1);
            }
            return [];
          },
        }),
      }),
    }),
    delete: () => ({
      where: async () => {},
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

// ─── Manifest seeding helpers ──────────────────────────────────────────────

const MANIFEST_PREAMBLE = `kortix_version = 1\n[project]\nname = "Apps Project"\n`;

function seedManifest(...appBlocks: string[]) {
  const body = appBlocks.length === 0
    ? MANIFEST_PREAMBLE
    : `${MANIFEST_PREAMBLE}\n${appBlocks.join('\n\n')}\n`;
  repoFiles.set(MANIFEST_PATH, body);
}

// Construction helpers for each accepted shape (matches what the user
// asked for: "test it with some repos containing all the different types
// of config acceptable").

function minimalGitApp(opts: { slug: string; domain: string }): string {
  return [
    '[[apps]]',
    `slug = "${opts.slug}"`,
    `domains = ["${opts.domain}"]`,
    '',
    '  [apps.source]',
    '  type = "git"',
    '  repo = "https://github.com/me/x"',
  ].join('\n');
}

function fullGitApp(opts: {
  slug: string;
  name?: string;
  enabled?: boolean;
  framework?: string;
  domain: string;
  branch?: string;
  rootPath?: string;
  buildCommand?: string;
  buildOutDir?: string;
  env?: Record<string, string>;
}): string {
  const lines: string[] = ['[[apps]]', `slug = "${opts.slug}"`];
  if (opts.name !== undefined) lines.push(`name = "${opts.name}"`);
  if (opts.enabled !== undefined) lines.push(`enabled = ${opts.enabled}`);
  if (opts.framework !== undefined) lines.push(`framework = "${opts.framework}"`);
  lines.push(`domains = ["${opts.domain}"]`);
  lines.push('');
  lines.push('  [apps.source]');
  lines.push('  type = "git"');
  lines.push('  repo = "https://github.com/me/full"');
  if (opts.branch !== undefined) lines.push(`  branch = "${opts.branch}"`);
  if (opts.rootPath !== undefined) lines.push(`  root_path = "${opts.rootPath}"`);
  if (opts.buildCommand || opts.buildOutDir) {
    lines.push('');
    lines.push('  [apps.build]');
    if (opts.buildCommand) lines.push(`  command = "${opts.buildCommand}"`);
    if (opts.buildOutDir) lines.push(`  out_dir = "${opts.buildOutDir}"`);
  }
  if (opts.env && Object.keys(opts.env).length > 0) {
    lines.push('');
    lines.push('  [apps.env]');
    for (const [k, v] of Object.entries(opts.env)) {
      lines.push(`  ${k} = "${v}"`);
    }
  }
  return lines.join('\n');
}

function tarApp(opts: { slug: string; url: string; domain: string }): string {
  return [
    '[[apps]]',
    `slug = "${opts.slug}"`,
    `domains = ["${opts.domain}"]`,
    '',
    '  [apps.source]',
    '  type = "tar"',
    `  url = "${opts.url}"`,
  ].join('\n');
}

function gitAppDefaultRepo(opts: { slug: string; domain: string }): string {
  // No `repo` — should fall back to the project's repoUrl at deploy time.
  return [
    '[[apps]]',
    `slug = "${opts.slug}"`,
    `domains = ["${opts.domain}"]`,
    '',
    '  [apps.source]',
    '  type = "git"',
  ].join('\n');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /v1/projects/:id/apps — list reflects manifest', () => {
  beforeEach(() => resetState());

  test('empty when no [[apps]] declared', async () => {
    seedManifest();
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps).toEqual([]);
    expect(body.errors).toEqual([]);
  });

  test('lists every shape in a manifest that contains all of them', async () => {
    seedManifest(
      minimalGitApp({ slug: 'minimal', domain: 'minimal.style.dev' }),
      fullGitApp({
        slug: 'full',
        name: 'Full',
        enabled: true,
        framework: 'next',
        domain: 'full.style.dev',
        branch: 'main',
        rootPath: 'apps/full',
        buildCommand: 'pnpm build',
        buildOutDir: 'dist',
        env: { FOO: 'bar', BAZ: 'qux' },
      }),
      tarApp({
        slug: 'tarball',
        url: 'https://example.com/build.tar.gz',
        domain: 'tarball.style.dev',
      }),
      gitAppDefaultRepo({ slug: 'self', domain: 'self.style.dev' }),
    );
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toEqual([]);
    expect(body.apps.map((a: any) => a.slug)).toEqual(['full', 'minimal', 'self', 'tarball']);
    expect(body.apps.find((a: any) => a.slug === 'full')).toMatchObject({
      slug: 'full',
      name: 'Full',
      enabled: true,
      framework: 'next',
      domains: ['full.style.dev'],
    });
    expect(body.apps.find((a: any) => a.slug === 'tarball').source).toMatchObject({
      type: 'tar',
      url: 'https://example.com/build.tar.gz',
    });
    expect(body.apps.find((a: any) => a.slug === 'self').source).toMatchObject({
      type: 'git',
      repo: null,
    });
    // No deployments yet — drift is true for every entry.
    for (const a of body.apps) expect(a.drift).toBe(true);
  });

  test('parser errors come back alongside good entries', async () => {
    seedManifest(
      minimalGitApp({ slug: 'good', domain: 'g.style.dev' }),
      // Bad: missing source block.
      '[[apps]]\nslug = "bad"\ndomains = ["b.style.dev"]\n',
    );
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps.map((a: any) => a.slug)).toEqual(['good']);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].error).toMatch(/\[apps\.source\] is required/);
  });
});

describe('POST /v1/projects/:id/apps — create commits to manifest', () => {
  beforeEach(() => resetState());

  test('commits a minimal git app', async () => {
    seedManifest();
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'My Site',
        domains: ['mysite.style.dev'],
        source: { type: 'git', repo: 'https://github.com/me/mysite' },
      }),
    });
    expect(res.status).toBe(201);
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]!.path).toBe(MANIFEST_PATH);
    expect(commitCalls[0]!.message).toBe('chore: add app my-site');
    expect(commitCalls[0]!.content).toContain('[[apps]]');
    expect(commitCalls[0]!.content).toContain('slug = "my-site"');
    const body = await res.json();
    expect(body.apps[0]).toMatchObject({ slug: 'my-site', name: 'My Site' });
  });

  test('commits a full git app with branch + root_path + build + env', async () => {
    seedManifest();
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'mono',
        name: 'Monorepo app',
        domains: ['mono.style.dev'],
        framework: 'next',
        source: {
          type: 'git',
          repo: 'https://github.com/me/mono',
          branch: 'release',
          root_path: 'apps/web',
        },
        build: { command: 'pnpm build', out_dir: 'dist' },
        env: { FOO: 'bar' },
      }),
    });
    expect(res.status).toBe(201);
    const content = commitCalls[0]!.content;
    expect(content).toContain('branch = "release"');
    expect(content).toContain('root_path = "apps/web"');
    expect(content).toContain('command = "pnpm build"');
    expect(content).toContain('out_dir = "dist"');
    expect(content).toContain('FOO = "bar"');
    expect(content).toContain('framework = "next"');
  });

  test('commits a tar app', async () => {
    seedManifest();
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'tarball',
        domains: ['tar.style.dev'],
        source: { type: 'tar', url: 'https://example.com/build.tar.gz' },
      }),
    });
    expect(res.status).toBe(201);
    expect(commitCalls[0]!.content).toContain('type = "tar"');
    expect(commitCalls[0]!.content).toContain('https://example.com/build.tar.gz');
  });

  test('rejects duplicate slug with 409', async () => {
    seedManifest(minimalGitApp({ slug: 'dup', domain: 'dup.style.dev' }));
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'dup',
        domains: ['dup2.style.dev'],
        source: { type: 'git', repo: 'https://github.com/me/x' },
      }),
    });
    expect(res.status).toBe(409);
    expect(commitCalls).toHaveLength(0);
  });

  test('extraneous `provider` in body is silently ignored (manifest schema has no provider knob)', async () => {
    seedManifest();
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'x',
        provider: 'magic-cloud',
        domains: ['x.style.dev'],
        source: { type: 'git', repo: 'https://github.com/me/x' },
      }),
    });
    expect(res.status).toBe(201);
    // Committed manifest must NOT contain `provider = ...` even though the
    // request tried to set one.
    expect(commitCalls[0]!.content).not.toContain('provider =');
  });

  test('rejects missing required fields', async () => {
    seedManifest();
    const app = createApp();
    const cases: Array<{ body: unknown; expect: RegExp }> = [
      { body: { domains: ['x.dev'], source: { type: 'git', repo: 'r' } }, expect: /name \(or slug\) is required/ },
      { body: { slug: 'x', source: { type: 'git', repo: 'r' } }, expect: /domains must be a non-empty array/ },
      { body: { slug: 'x', domains: ['x.dev'] }, expect: /source\.type must be/ },
      { body: { slug: 'x', domains: ['x.dev'], source: { type: 'tar' } }, expect: /type="tar" requires/ },
    ];
    for (const c of cases) {
      const res = await app.request(`/v1/projects/${PROJECT_ID}/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(c.expect);
    }
  });
});

describe('PATCH /v1/projects/:id/apps/:slug — partial update', () => {
  beforeEach(() => resetState());

  test('flips enabled without touching other fields', async () => {
    seedManifest(fullGitApp({
      slug: 'p',
      domain: 'p.style.dev',
      branch: 'main',
      buildCommand: 'pnpm build',
      env: { FOO: 'bar' },
    }));
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/p`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const content = commitCalls.at(-1)!.content;
    expect(content).toContain('enabled = false');
    expect(content).toContain('branch = "main"');
    expect(content).toContain('FOO = "bar"');
  });

  test('404 on unknown slug', async () => {
    seedManifest(minimalGitApp({ slug: 'a', domain: 'a.style.dev' }));
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/nope`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/projects/:id/apps/:slug — removes from manifest', () => {
  beforeEach(() => resetState());

  test('removes the entry and commits', async () => {
    seedManifest(
      minimalGitApp({ slug: 'keep', domain: 'k.style.dev' }),
      minimalGitApp({ slug: 'drop', domain: 'd.style.dev' }),
    );
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/drop`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const content = commitCalls.at(-1)!.content;
    expect(content).toContain('slug = "keep"');
    expect(content).not.toContain('slug = "drop"');
  });
});

describe('POST /v1/projects/:id/apps/:slug/deploy — manual deploy', () => {
  beforeEach(() => resetState());

  test('deploys a minimal git app via Freestyle and persists a row', async () => {
    seedManifest(minimalGitApp({ slug: 'mini', domain: 'mini.style.dev' }));
    freestyleResponse = {
      ok: true,
      status: 200,
      json: async () => ({ deploymentId: 'fst-mini' }),
    };

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/mini/deploy`, {
      method: 'POST',
    });
    expect(res.status).toBe(201);

    expect(freestyleCalls).toHaveLength(1);
    expect(freestyleCalls[0]!.url).toContain('/web/v1/deployment');
    const sent = freestyleCalls[0]!.body as any;
    expect(sent.source).toMatchObject({ kind: 'git', url: 'https://github.com/me/x' });
    expect(sent.config.domains).toEqual(['mini.style.dev']);

    expect(deploymentRows).toHaveLength(1);
    const row = deploymentRows[0]!;
    expect(row.projectId).toBe(PROJECT_ID);
    expect(row.appSlug).toBe('mini');
    expect(row.provider).toBe('freestyle');
    expect(row.freestyleId).toBe('fst-mini');
    expect(row.status).toBe('active');
    expect(row.liveUrl).toBe('https://mini.style.dev');
    expect((row.metadata as any).manifest_hash).toBeTruthy();
    expect((row.metadata as any).source).toBe('manual');
  });

  test('deploys a full git app — branch + rootPath + build + env all flow through', async () => {
    seedManifest(fullGitApp({
      slug: 'full',
      domain: 'full.style.dev',
      framework: 'next',
      branch: 'main',
      rootPath: 'apps/web',
      buildCommand: 'pnpm build',
      buildOutDir: 'dist',
      env: { FOO: 'bar' },
    }));
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/full/deploy`, { method: 'POST' });
    expect(res.status).toBe(201);
    const sent = freestyleCalls.at(-1)!.body as any;
    expect(sent.source).toMatchObject({
      kind: 'git',
      url: 'https://github.com/me/full',
      branch: 'main',
      dir: 'apps/web',
    });
    expect(sent.config).toMatchObject({
      domains: ['full.style.dev'],
      envVars: { FOO: 'bar' },
    });
    expect(sent.config.build).toMatchObject({ command: 'pnpm build', outDir: 'dist' });

    expect(deploymentRows[0]!.framework).toBe('next');
    expect(deploymentRows[0]!.envVars).toEqual({ FOO: 'bar' });
  });

  test('deploys a tar app — url makes it into the source payload', async () => {
    seedManifest(tarApp({ slug: 'tball', url: 'https://example.com/t.tgz', domain: 't.style.dev' }));
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/tball/deploy`, { method: 'POST' });
    expect(res.status).toBe(201);
    const sent = freestyleCalls.at(-1)!.body as any;
    expect(sent.source).toEqual({ kind: 'tar', url: 'https://example.com/t.tgz' });
    expect(deploymentRows[0]!.sourceType).toBe('tar');
    expect(deploymentRows[0]!.sourceRef).toBe('https://example.com/t.tgz');
  });

  test('git app with no explicit repo falls back to the project repoUrl', async () => {
    seedManifest(gitAppDefaultRepo({ slug: 'self', domain: 's.style.dev' }));
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/self/deploy`, { method: 'POST' });
    expect(res.status).toBe(201);
    const sent = freestyleCalls.at(-1)!.body as any;
    expect(sent.source.url).toBe(projectRow.repoUrl);
    expect(sent.source.branch).toBe(projectRow.defaultBranch);
  });

  test('upstream failure persists a row with status="failed" and an error', async () => {
    seedManifest(minimalGitApp({ slug: 'fail', domain: 'f.style.dev' }));
    freestyleResponse = {
      ok: false,
      status: 422,
      json: async () => ({ message: 'no quota' }),
      text: async () => JSON.stringify({ message: 'no quota' }),
    };

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/fail/deploy`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(deploymentRows[0]!.status).toBe('failed');
    expect(deploymentRows[0]!.error).toBe('no quota');
  });

  test('404 when slug is not declared in manifest', async () => {
    seedManifest(minimalGitApp({ slug: 'a', domain: 'a.style.dev' }));
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/missing/deploy`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(freestyleCalls).toHaveLength(0);
  });
});

describe('POST /v1/projects/:id/apps/:slug/stop — best-effort teardown', () => {
  beforeEach(() => resetState());

  test('calls provider DELETE and flips the row to "stopped"', async () => {
    seedManifest(minimalGitApp({ slug: 'live', domain: 'live.style.dev' }));
    const app = createApp();
    // Deploy first so there's a row + freestyleId to stop.
    await app.request(`/v1/projects/${PROJECT_ID}/apps/live/deploy`, { method: 'POST' });
    const beforeCalls = freestyleCalls.length;

    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/live/stop`, { method: 'POST' });
    expect(res.status).toBe(200);

    // One additional Freestyle call (the DELETE).
    expect(freestyleCalls.length).toBe(beforeCalls + 1);
    expect(freestyleCalls.at(-1)!.method).toBe('DELETE');
    expect(deploymentRows[0]!.status).toBe('stopped');
  });

  test('404 when no deployment exists for the slug', async () => {
    seedManifest(minimalGitApp({ slug: 'ghost', domain: 'g.style.dev' }));
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/apps/ghost/stop`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
