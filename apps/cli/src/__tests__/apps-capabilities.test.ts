import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deployOrder } from '../commands/apps-capabilities';

// Black-box tests of `kortix apps` for capabilities and links: the real CLI
// process against a fake Kortix API holding two Apps (site, db). Synthetic ids
// and values only.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = '11111111-2222-4333-8444-555555555555';
const DB_ID = '99999999-8888-4777-8666-555555555555';
const SITE_ID = '77777777-6666-4555-8444-333333333333';
const ISSUER = `https://api.example.test/v1/projects/${PROJECT}`;

type Row = Record<string, unknown> & { app_id: string; slug: string; uses: string[] };

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 0;
let calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
let rows: Map<string, Row>;

function baseApp(id: string, slug: string, extra: Record<string, unknown> = {}): Row {
  return {
    app_id: id,
    account_id: 'account_1',
    project_id: PROJECT,
    capabilities: ['deployments', 'rollback', 'preview', 'member_tokens', 'sleep'],
    slug,
    name: slug,
    url: `https://${slug}.apps.example.test`,
    access_mode: 'private',
    access_revision: 1,
    desired_state: 'running',
    active_deployment_id: null,
    machine: { cpu: 1, memory_gb: 1, disk_gb: 10 },
    idle_timeout_seconds: 300,
    always_on: slug === 'db',
    estimated_monthly_usd: slug === 'db' ? 59 : 0,
    hosting_type: 'sandbox',
    auth: { issuer: ISSUER, audience: id, jwks_uri: `${ISSUER}/jwks.json` },
    uses: [],
    used_by: [],
    last_request_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function deployment(appId: string, overrides: Record<string, unknown> = {}) {
  return {
    deployment_id: `dep-${appId.slice(0, 4)}`,
    app_id: appId,
    artifact_id: 'art-1',
    version: 3,
    status: 'ready',
    source_kind: 'static',
    hosting_type: 'static',
    hosting_provider: null,
    runtime_spec: {},
    build_spec: {},
    error_code: null,
    error: null,
    attempt_count: 0,
    started_at: null,
    ready_at: null,
    failed_at: null,
    created_by: 'user_1',
    source_session_id: null,
    actor_type: 'human',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const unsupported = (capability: string) =>
  Response.json(
    { error: `This App does not support ${capability}.`, code: 'app_capability_unsupported', capability },
    { status: 409 },
  );

function startServer(): string {
  const base = `/v1/projects/${PROJECT}`;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === 'GET' || path.startsWith('/upload') ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path, query: url.search, body });
      const byId = (id: string) => [...rows.values()].find((row) => row.app_id === id);

      if (path === base && req.method === 'GET') {
        return Response.json({
          project_id: PROJECT,
          account_id: 'account_1',
          name: 'Atlas',
          repo_url: 'https://example.test/r.git',
          default_branch: 'main',
          manifest_path: 'kortix.yaml',
          status: 'active',
          metadata: {},
          experimental: { apps: true },
          dashboard_url: `https://web.example.test/projects/${PROJECT}`,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        });
      }
      if (path === `${base}/apps` && req.method === 'GET') return Response.json({ apps: [...rows.values()] });
      if (path === `${base}/apps` && req.method === 'POST') {
        const input = body as { slug: string; name: string; uses?: string[] };
        const id = input.slug === 'db' ? DB_ID : SITE_ID;
        const row = baseApp(id, input.slug, { uses: input.uses ?? [] });
        rows.set(input.slug, row);
        return Response.json(row, { status: 201 });
      }
      if (path === `${base}/apps/artifacts` && req.method === 'POST') {
        return Response.json({
          artifact: { artifact_id: 'art-1', project_id: PROJECT, kind: 'archive', status: 'uploading', image_reference: null, sha256: null, size_bytes: null, media_type: null, error: null, created_at: '2026-01-01T00:00:00.000Z' },
          upload: { url: `http://127.0.0.1:${serverPort}/upload/source.tar.gz`, max_bytes: 10_000_000 },
        });
      }
      if (path === '/upload/source.tar.gz') return new Response(null, { status: 200 });
      if (path === `${base}/apps/artifacts/art-1/finalize`) {
        return Response.json({ artifact_id: 'art-1', project_id: PROJECT, kind: 'archive', status: 'ready', image_reference: null, sha256: null, size_bytes: 1, media_type: null, error: null, created_at: '2026-01-01T00:00:00.000Z' });
      }
      const match = /^\/v1\/projects\/[^/]+\/apps\/([^/]+)(?:\/(.+))?$/.exec(path);
      const row = match ? byId(match[1]!) : undefined;
      if (!match || !row) return Response.json({ error: 'Not found' }, { status: 404 });
      const rest = match[2];

      if (!rest && req.method === 'GET') return Response.json(row);
      if (!rest && req.method === 'PATCH') {
        const input = body as Record<string, unknown>;
        Object.assign(row, input.uses ? { uses: input.uses } : {});
        return Response.json(row);
      }
      if (!rest && req.method === 'DELETE') {
        rows.delete(row.slug);
        return Response.json({ ok: true, images: { released: 1, pending: 0 } });
      }
      if (rest === 'deployments' && req.method === 'GET') return Response.json({ deployments: [] });
      if (rest === 'deployments' && req.method === 'POST') return Response.json(deployment(row.app_id), { status: 202 });
      if (rest === `deployments/dep-${row.app_id.slice(0, 4)}`) {
        return Response.json({ deployment: deployment(row.app_id), events: [] });
      }
      if (rest === 'token') return Response.json({ token: 'h.p.s', expires_at: '2026-10-06T01:00:00.000Z' });
      if (rest === 'snapshots' || rest === 'credentials') return unsupported(rest);
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  serverPort = server.port ?? 0;
  return `http://127.0.0.1:${server.port}`;
}

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_apps',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
  );
  return path;
}

async function runCli(args: string[], config: string, extraEnv: Record<string, string> = {}, cwd = tmp) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: config,
    ...extraEnv,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 20_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

const P = ['--project', PROJECT];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-apps-capabilities-'));
  calls = [];
  rows = new Map([
    ['db', baseApp(DB_ID, 'db', { used_by: ['site'] })],
    ['site', baseApp(SITE_ID, 'site', { uses: ['db'], capabilities: ['deployments', 'rollback', 'preview', 'static'] })],
  ]);
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe('deployOrder', () => {
  test('an App deploys after every App it uses, then by name', () => {
    expect(
      deployOrder({
        site: { uses: ['api', 'db'] },
        api: { uses: ['db'] },
        db: {},
        docs: {},
        auth: {},
      }),
    ).toEqual(['auth', 'db', 'api', 'docs', 'site']);
    expect(deployOrder({ admin: {}, store: {} })).toEqual(['admin', 'store']);
  });

  test('a cycle is refused and named; a use outside the manifest is ignored', () => {
    expect(() => deployOrder({ a: { uses: ['b'] }, b: { uses: ['a'] } })).toThrow('a, b');
    expect(deployOrder({ site: { uses: ['elsewhere'] } })).toEqual(['site']);
  });
});

describe('kortix apps — capabilities and links', () => {
  test('--help lists the subcommands and no retired one', async () => {
    const r = await runCli(['apps', '--help'], join(tmp, 'none.json'));
    expect(r.code).toBe(0);
    for (const sub of [
      '--uses <slugs>', 'link <id|slug> --uses <slugs>', 'unlink <id|slug> --uses <slugs>', 'token <id|slug>', 'connect <id|slug>',
      'launch --template <name>', 'releases <id|slug>', 'machines [ls] <id|slug>', 'scale count <id|slug> <n>',
      'exec <id|slug> -- <command…>', 'volumes [ls] <id|slug>', 'labels <id|slug>', 'auth-env <id|slug>',
    ]) {
      expect(r.stdout).toContain(sub);
    }
    // Retired: the convex kind's subcommands and flags. `convex` survives only as a template name.
    expect(r.stdout).not.toMatch(/backends|--kind|credentials|^ {2}(dashboard|snapshots?|restore|delete-snapshot)\b|--confirm/im);
  });

  test('`kortix backends` is gone', async () => {
    const r = await runCli(['backends', 'list'], join(tmp, 'none.json'));
    expect(r.code).not.toBe(0);
  });

  test('retired subcommands are unknown', async () => {
    const config = writeConfig(startServer());
    for (const sub of ['snapshots', 'snapshot', 'delete-snapshot', 'restore', 'credentials', 'rotate-credentials', 'dashboard']) {
      const r = await runCli(['apps', sub, 'db', ...P], config);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`unknown Apps subcommand "${sub}"`);
    }
    expect(calls.some((c) => c.path.endsWith('/snapshots') || c.path.endsWith('/credentials'))).toBe(false);
  });

  test('list shows slug, state and URL with no kind; show prints capabilities and links', async () => {
    const config = writeConfig(startServer());
    const table = await runCli(['apps', 'ls', ...P], config);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/SLUG\s+STATE\s+URL/);
    expect(table.stdout).not.toMatch(/KIND/);
    expect(table.stdout).toMatch(/db\s+undeployed\s+https:\/\/db\.apps\.example\.test/);
    const show = await runCli(['apps', 'show', 'db', ...P], config);
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/capabilities\s+deployments, rollback, preview, member_tokens, sleep/);
    expect(show.stdout).toMatch(/runs\s+24\/7/);
    expect(show.stdout).not.toMatch(/\$|USD|month|cost/);
    expect(show.stdout).not.toMatch(/budget|kind/);
    expect(show.stdout).toMatch(/used by\s+site/);
    const site = await runCli(['apps', 'show', 'site', ...P], config);
    expect(site.stdout).toMatch(/uses\s+db/);
  });

  test('create POSTs the size and uses; --kind is not a flag', async () => {
    rows.delete('db');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'create', 'db', '--cpu', '2', '--uses', 'site', ...P], config);
    if (r.code !== 0) console.error(r.stderr);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ slug: 'db', name: 'db', cpu: 2, uses: ['site'] });
    expect(r.stdout).toContain('created db');
  });

  test('set --uses replaces the links', async () => {
    const config = writeConfig(startServer());
    const linked = await runCli(['apps', 'set', 'site', '--uses', 'db, billing,db', ...P], config);
    expect(linked.code).toBe(0);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ uses: ['db', 'billing'] });
    calls = [];
    const cleared = await runCli(['apps', 'set', 'site', '--uses=', ...P], config);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ uses: [] });
    expect(cleared.stdout).toMatch(/uses\s+none/);
    const bad = await runCli(['apps', 'set', 'site', '--uses', 'Bad_Slug', ...P], config);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('--uses');
  });

  test('link adds to the Apps an App uses; unlink removes them', async () => {
    const config = writeConfig(startServer());
    const link = await runCli(['apps', 'link', 'site', '--uses', 'auth', ...P], config);
    expect(link.code).toBe(0);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ uses: ['db', 'auth'] });
    expect(link.stdout).toMatch(/site uses db, auth/);
    calls = [];
    const unlink = await runCli(['apps', 'unlink', 'site', '--uses', 'db', ...P], config);
    expect(unlink.code).toBe(0);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ uses: ['auth'] });
    const missing = await runCli(['apps', 'link', 'site', ...P], config);
    expect(missing.code).toBe(2);
  });

  test('token prints the JWT alone for an App with member_tokens; --json adds expires_at', async () => {
    const config = writeConfig(startServer());
    const plain = await runCli(['apps', 'token', 'db', ...P], config);
    expect(plain.code).toBe(0);
    expect(plain.stdout.trim()).toBe('h.p.s');
    const asJson = await runCli(['apps', 'token', 'db', '--json', ...P], config);
    expect(JSON.parse(asJson.stdout)).toEqual({ token: 'h.p.s', expires_at: '2026-10-06T01:00:00.000Z' });
  });

  test('token for an App without member_tokens fails before the token call', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'token', 'site', ...P], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('App site does not support member tokens.');
    expect(calls.some((c) => c.path.endsWith(`/apps/${SITE_ID}/token`))).toBe(false);
  });

  test('connect prints the App URL, its uses and the generic snippets; no Convex, no admin key', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'connect', 'db', ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('https://db.apps.example.test');
    expect(r.stdout).toContain('uses: none');
    expect(r.stdout).toContain('kortix apps link <app> --uses db');
    expect(r.stdout).toContain('kortixBinding("db")');
    expect(r.stdout).toContain(`KORTIX_AUTH_JWKS=${ISSUER}/jwks.json`);
    expect(r.stdout).not.toMatch(/convex|credentials|admin/i);
    const json = await runCli(['apps', 'connect', 'db', '--json', ...P], config);
    expect(JSON.parse(json.stdout).snippets.some((s: { id: string }) => s.id === 'app-client')).toBe(true);
  });

  test('delete needs --yes; the answer names the freed images', async () => {
    const config = writeConfig(startServer());
    const refused = await runCli(['apps', 'delete', 'db', ...P], config);
    expect(refused.code).toBe(2);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const r = await runCli(['apps', 'delete', 'db', '--yes', ...P], config);
    expect(r.code).toBe(0);
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.path).toBe(`/v1/projects/${PROJECT}/apps/${DB_ID}`);
    expect(del?.query).toBe('');
    expect(r.stdout).toContain('deleted db');
    expect(r.stdout).toContain('freed 1 deployment image');
  });

  test('a directory with a convex/ folder deploys like any other App', async () => {
    const config = writeConfig(startServer());
    mkdirSync(join(tmp, 'convex'), { recursive: true });
    writeFileSync(join(tmp, 'index.html'), '<h1>hi</h1>\n');
    const r = await runCli(['apps', 'deploy', '--app', 'site', ...P], config);
    if (r.code !== 0) console.error(r.stderr);
    expect(r.code).toBe(0);
    expect(calls.some((c) => c.path.endsWith('/apps/artifacts'))).toBe(true);
    expect(calls.find((c) => c.path.endsWith(`/apps/${SITE_ID}/deployments`) && c.method === 'POST')?.body).toMatchObject({ artifact_id: 'art-1' });
  });

  test('deploy with no arguments deploys every manifest App in link order: the used App first', async () => {
    rows.delete('db');
    rows.delete('site');
    const config = writeConfig(startServer());
    mkdirSync(join(tmp, 'db'), { recursive: true });
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'index.html'), '<h1>hi</h1>\n');
    writeFileSync(join(tmp, 'db', 'index.html'), '<h1>db</h1>\n');
    writeFileSync(
      join(tmp, 'kortix.yaml'),
      ['kortix_version: 2', 'apps:', '  site:', '    path: site', '    type: static', '    uses: [db]', '  db:', '    path: db', '    type: static', '    resources:', '      cpu: 2', ''].join('\n'),
    );
    const r = await runCli(['apps', 'deploy', ...P], config);
    if (r.code !== 0) console.error(r.stdout, r.stderr);
    expect(r.code).toBe(0);
    const creates = calls.filter((c) => c.method === 'POST' && c.path === `/v1/projects/${PROJECT}/apps`).map((c) => c.body);
    expect(creates).toEqual([
      { slug: 'db', name: 'db', cpu: 2 },
      { slug: 'site', name: 'site', uses: ['db'] },
    ]);
    const records = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/deployments')).map((c) => c.path);
    expect(records).toEqual([`/v1/projects/${PROJECT}/apps/${DB_ID}/deployments`, `/v1/projects/${PROJECT}/apps/${SITE_ID}/deployments`]);
  });
});
