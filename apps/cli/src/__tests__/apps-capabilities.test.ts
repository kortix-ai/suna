import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deployOrder, renderEnv, shellQuote } from '../commands/apps-capabilities';

// Black-box tests of `kortix apps` for App kinds and capabilities: the real CLI
// process against a fake Kortix API holding one `web` App (site) and one
// `convex` App (db). Synthetic ids and values only.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = '11111111-2222-4333-8444-555555555555';
const DB_ID = '99999999-8888-4777-8666-555555555555';
const SITE_ID = '77777777-6666-4555-8444-333333333333';
const ADMIN_KEY = "db|it's a $key";
const ISSUER = `https://api.example.test/v1/projects/${PROJECT}`;

type Row = Record<string, unknown> & { app_id: string; slug: string; kind: string; uses: string[] };

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 0;
let calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
let rows: Map<string, Row>;
/** GETs of the convex App left before its instance settles (provisioning or an operation). */
let busyPolls = 0;
let snapshots: Array<Record<string, unknown>> = [];

const CONVEX_CAPABILITIES = ['deployments', 'snapshots', 'restore', 'admin_credentials', 'dashboard', 'logs', 'member_tokens'];

function instance(overrides: Record<string, unknown> = {}) {
  return {
    status: 'running',
    url: 'https://db.apps.example.test',
    site_url: 'https://db-site.apps.example.test',
    dashboard_url: 'https://db-dashboard.apps.example.test',
    error: null,
    operation: null,
    last_operation_error: null,
    health: null,
    auth_env: null,
    client_version: '1.46.0',
    budget_alert: null,
    purge_after: null,
    ...overrides,
  };
}

function baseApp(id: string, slug: string, kind: string, extra: Record<string, unknown> = {}): Row {
  return {
    app_id: id,
    account_id: 'account_1',
    project_id: PROJECT,
    kind,
    capabilities: kind === 'convex' ? CONVEX_CAPABILITIES : ['deployments', 'rollback', 'preview', 'member_tokens', 'static'],
    slug,
    name: slug,
    url: kind === 'convex' ? 'https://db.apps.example.test' : `https://${slug}.apps.example.test`,
    access_mode: 'private',
    access_revision: 1,
    desired_state: 'running',
    active_deployment_id: null,
    machine: { cpu: 1, memory_gb: 1, disk_gb: 10 },
    idle_timeout_seconds: 300,
    always_on: kind === 'convex',
    monthly_budget_usd: null,
    estimated_monthly_usd: kind === 'convex' ? 59 : 0,
    hosting_type: kind === 'convex' ? 'convex' : 'static',
    auth: { issuer: ISSUER, audience: id, jwks_uri: `${ISSUER}/jwks.json` },
    uses: [],
    used_by: [],
    instance: kind === 'convex' ? instance() : null,
    last_request_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** The App as the API answers it: the convex instance reflects `busyPolls`. */
function view(row: Row): Row {
  if (row.kind !== 'convex' || busyPolls === 0) return row;
  return { ...row, instance: instance(row.instance_state as Record<string, unknown>) };
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

const credentials = () => ({
  url: 'https://db.apps.example.test',
  site_url: 'https://db-site.apps.example.test',
  admin_key: ADMIN_KEY,
  env: { CONVEX_SELF_HOSTED_URL: 'https://db.apps.example.test', CONVEX_SELF_HOSTED_ADMIN_KEY: ADMIN_KEY },
});

const unsupported = (capability: string, kind: string) =>
  Response.json(
    { error: `This App does not support ${capability}.`, code: 'app_capability_unsupported', capability, kind },
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
      if (path === `${base}/apps` && req.method === 'GET') return Response.json({ apps: [...rows.values()].map(view) });
      if (path === `${base}/apps` && req.method === 'POST') {
        const input = body as { slug: string; name: string; kind?: string; uses?: string[] };
        const id = input.kind === 'convex' ? DB_ID : SITE_ID;
        const row = baseApp(id, input.slug, input.kind ?? 'web', { uses: input.uses ?? [] });
        rows.set(input.slug, row);
        if (input.kind === 'convex') {
          busyPolls = 2;
          row.instance_state = { status: 'provisioning', url: null, site_url: null };
        }
        return Response.json(view(row), { status: 201 });
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
      const convex = row.kind === 'convex';

      if (!rest && req.method === 'GET') {
        const answer = view(row);
        if (busyPolls > 0) busyPolls -= 1;
        return Response.json(answer);
      }
      if (!rest && req.method === 'PATCH') {
        const input = body as Record<string, unknown>;
        Object.assign(row, input.uses ? { uses: input.uses } : {});
        if (convex && input.cpu !== undefined) {
          busyPolls = 2;
          row.instance_state = { operation: 'resizing' };
          row.machine = { ...(row.machine as object), cpu: input.cpu };
        }
        return Response.json(view(row));
      }
      if (!rest && req.method === 'DELETE') {
        const confirm = url.searchParams.get('confirm');
        if (convex && confirm !== row.slug) {
          return Response.json({ error: `This App holds data. Type its slug to delete it: confirm=${row.slug}.`, code: 'confirmation_required' }, { status: 400 });
        }
        rows.delete(row.slug);
        return Response.json(
          convex
            ? { ok: true, images: { released: 0, pending: 0 }, retained_until: '2026-01-08T00:00:00.000Z', final_snapshot_id: 'snap-final' }
            : { ok: true, images: { released: 1, pending: 0 } },
        );
      }
      if (rest === 'deployments' && req.method === 'GET') return Response.json({ deployments: [] });
      if (rest === 'deployments' && req.method === 'POST') {
        if (convex) {
          return Response.json(deployment(row.app_id, { artifact_id: null, source_kind: 'convex', hosting_type: 'convex', build_spec: body }), { status: 201 });
        }
        return Response.json(deployment(row.app_id), { status: 202 });
      }
      if (rest === `deployments/dep-${row.app_id.slice(0, 4)}`) {
        return Response.json({ deployment: deployment(row.app_id), events: [] });
      }
      if (!convex) return unsupported(rest ?? 'that', row.kind);
      if (rest === 'snapshots' && req.method === 'GET') {
        return Response.json({
          automatic: { state: 'ok', last_backup_at: '2026-01-01T00:00:00.000Z', size_bytes: 2048, interval_minutes: 60 },
          snapshots,
          snapshot_limit: 10,
          snapshot_schedule: { automatic_interval_hours: 24, automatic_retention_days: 7, resize_retention_hours: 24, last_automatic_at: '2026-01-01T03:00:00.000Z' },
        });
      }
      if (rest === 'snapshots' && req.method === 'POST') {
        return Response.json({ snapshot_id: 'snap-new', created_at: '2026-01-02T00:00:00.000Z', size_bytes: null, kind: 'manual', expires_at: null }, { status: 201 });
      }
      if (rest?.startsWith('snapshots/') && req.method === 'DELETE') {
        const id = rest.slice('snapshots/'.length);
        if (!snapshots.some((snapshot) => snapshot.snapshot_id === id)) {
          return Response.json({ error: 'no such snapshot', code: 'snapshot_not_found' }, { status: 404 });
        }
        snapshots = snapshots.filter((snapshot) => snapshot.snapshot_id !== id);
        return new Response(null, { status: 204 });
      }
      if (rest === 'restore') return Response.json(view(row));
      if (rest === 'credentials') return Response.json(credentials());
      if (rest === 'rotate-credentials') return Response.json(view(row));
      if (rest === 'token') return Response.json({ token: 'h.p.s', expires_at: '2026-10-06T01:00:00.000Z' });
      if (rest === 'logs') return Response.json({ log: `started (${url.searchParams.get('lines')} lines)\nconvex exited 1\n` });
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

/** A stand-in `npx` that records its argv, cwd and env, then exits with FAKE_NPX_EXIT. */
function installFakeNpx(): string {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const script = join(bin, 'npx');
  writeFileSync(
    script,
    `#!/bin/sh
{
  echo "args=$*"
  echo "cwd=$(pwd)"
  echo "url=$CONVEX_SELF_HOSTED_URL"
  echo "key=$CONVEX_SELF_HOSTED_ADMIN_KEY"
  echo "deploy_key=\${CONVEX_DEPLOY_KEY-unset}"
  echo "deployment=\${CONVEX_DEPLOYMENT-unset}"
} >> "$FAKE_NPX_LOG"
echo "convex says hi"
exit "\${FAKE_NPX_EXIT:-0}"
`,
  );
  chmodSync(script, 0o755);
  return bin;
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
const capabilityCalls = (suffix: string) => calls.filter((call) => call.path.endsWith(suffix));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-apps-kinds-'));
  calls = [];
  busyPolls = 0;
  rows = new Map([
    ['db', baseApp(DB_ID, 'db', 'convex', { used_by: ['site'] })],
    ['site', baseApp(SITE_ID, 'site', 'web', { uses: ['db'] })],
  ]);
  snapshots = [
    { snapshot_id: 'snap-1', created_at: '2026-01-01T00:00:00.000Z', size_bytes: 1048576, kind: 'manual', expires_at: null },
    { snapshot_id: 'snap-auto', created_at: '2026-01-01T03:00:00.000Z', size_bytes: 1048576, kind: 'automatic', expires_at: '2026-01-08T03:00:00.000Z' },
  ];
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe('env rendering', () => {
  test('shellQuote escapes single quotes so eval round-trips', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shellQuote('plain')).toBe("'plain'");
  });

  test('shell, dotenv and json formats', () => {
    const c = credentials();
    expect(renderEnv(c, 'shell')).toBe(
      `export CONVEX_SELF_HOSTED_URL='https://db.apps.example.test'\nexport CONVEX_SELF_HOSTED_ADMIN_KEY='db|it'\\''s a $key'\n`,
    );
    expect(renderEnv(c, 'dotenv')).toBe(
      `CONVEX_SELF_HOSTED_URL=https://db.apps.example.test\nCONVEX_SELF_HOSTED_ADMIN_KEY=${JSON.stringify(ADMIN_KEY)}\n`,
    );
    expect(JSON.parse(renderEnv(c, 'json'))).toEqual(c);
  });
});

describe('deployOrder', () => {
  test('an App deploys after every App it uses; convex before web, then by name', () => {
    expect(
      deployOrder({
        site: { uses: ['api', 'db'] },
        api: { uses: ['db'] },
        db: { kind: 'convex' },
        docs: {},
        auth: { kind: 'convex' },
      }),
    ).toEqual(['auth', 'db', 'api', 'docs', 'site']);
    expect(deployOrder({ admin: {}, store: { kind: 'convex' } })).toEqual(['store', 'admin']);
  });

  test('a cycle is refused and named; a use outside the manifest is ignored', () => {
    expect(() => deployOrder({ a: { uses: ['b'] }, b: { uses: ['a'] } })).toThrow('a, b');
    expect(deployOrder({ site: { uses: ['elsewhere'] } })).toEqual(['site']);
  });
});

describe('kortix apps — kinds and capabilities', () => {
  test('--help lists the capability subcommands', async () => {
    const r = await runCli(['apps', '--help'], join(tmp, 'none.json'));
    expect(r.code).toBe(0);
    for (const sub of ['--kind web|convex', '--uses <slugs>', 'link <id|slug> --uses <slugs>', 'unlink <id|slug> --uses <slugs>', 'snapshots <id|slug>', 'snapshot <id|slug>', 'delete-snapshot <id|slug> <snapshot-id>', 'restore <id|slug> <snapshot-id>', 'credentials <id|slug>', 'rotate-credentials <id|slug>', 'token <id|slug>', 'dashboard <id|slug>', 'connect <id|slug>', '--confirm <slug>']) {
      expect(r.stdout).toContain(sub);
    }
    expect(r.stdout).not.toMatch(/backends/i);
  });

  test('`kortix backends` is gone', async () => {
    const r = await runCli(['backends', 'list'], join(tmp, 'none.json'));
    expect(r.code).not.toBe(0);
  });

  test('list shows each App kind; show prints capabilities, links and the instance', async () => {
    const config = writeConfig(startServer());
    const table = await runCli(['apps', 'ls', ...P], config);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/SLUG\s+KIND\s+STATE/);
    expect(table.stdout).toMatch(/db\s+convex\s+running\s+https:\/\/db\.apps\.example\.test/);
    expect(table.stdout).toMatch(/site\s+web\s+undeployed/);
    const show = await runCli(['apps', 'show', 'db', ...P], config);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('convex · running');
    expect(show.stdout).toMatch(/capabilities\s+deployments, snapshots, restore, admin_credentials, dashboard, logs, member_tokens/);
    expect(show.stdout).toMatch(/cost\s+about \$59\/month \(1 vCPU · 1 GB, 24\/7\)/);
    expect(show.stdout).not.toContain('budget');
    expect(show.stdout).toMatch(/used by\s+site/);
    expect(show.stdout).toMatch(/site url\s+https:\/\/db-site\.apps\.example\.test/);
    const site = await runCli(['apps', 'show', 'site', ...P], config);
    expect(site.stdout).toMatch(/uses\s+db/);
    expect(site.stdout).not.toMatch(/budget|cost/);
  });

  test('create --kind convex POSTs the kind and size, waits until it runs; --no-wait returns at once', async () => {
    rows.delete('db');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'create', 'db', '--kind', 'convex', '--cpu', '2', '--uses', 'site', ...P], config);
    if (r.code !== 0) console.error(r.stderr);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ slug: 'db', name: 'db', kind: 'convex', cpu: 2, uses: ['site'] });
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith(`/apps/${DB_ID}`)).length).toBe(3);
    expect(r.stdout).toContain('created db');
    expect(r.stdout).toContain('https://db.apps.example.test');

    rows.delete('db');
    calls = [];
    const quick = await runCli(['apps', 'create', 'db', '--kind', 'convex', '--no-wait', ...P, '--json'], config);
    expect(quick.code).toBe(0);
    expect(JSON.parse(quick.stdout).instance.status).toBe('provisioning');
    expect(calls.some((c) => c.method === 'GET' && c.path.endsWith(`/apps/${DB_ID}`))).toBe(false);

    const bad = await runCli(['apps', 'create', 'x', '--kind', 'lambda', ...P], config);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--kind must be web or convex');
  });

  test('set --cpu on a convex App waits for the resize; set --uses replaces the links', async () => {
    const config = writeConfig(startServer());
    const resized = await runCli(['apps', 'set', 'db', '--cpu', '2', ...P], config);
    expect(resized.code).toBe(0);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ cpu: 2 });
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith(`/apps/${DB_ID}`)).length).toBeGreaterThanOrEqual(2);
    expect(resized.stdout).toMatch(/machine\s+2 vCPU/);

    calls = [];
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

  test('a capability the App lacks fails with its kind and capability, before the capability call', async () => {
    const config = writeConfig(startServer());
    for (const args of [['snapshots', 'site'], ['credentials', 'site'], ['dashboard', 'site'], ['restore', 'site', 'snap-1', '--yes']]) {
      calls = [];
      const r = await runCli(['apps', ...args, ...P], config);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/App site \(kind web\) does not support (snapshots|admin credentials|dashboard|restore)/);
      expect(calls.some((c) => c.path.endsWith(`/apps/${SITE_ID}/${args[0]}`))).toBe(false);
    }
  });

  test('snapshots prints the automatic backup, the schedule and each snapshot; --json is the raw payload', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'snapshots', 'db', ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('every 60 min');
    expect(r.stdout).toContain('2 · 1 of 10 manual');
    expect(r.stdout).toMatch(/snap-1\s+manual\s+2026-01-01 00:00 UTC\s+when deleted/);
    expect(r.stdout).toMatch(/snap-auto\s+automatic/);
    const json = await runCli(['apps', 'snapshots', 'db', '--json', ...P], config);
    expect(JSON.parse(json.stdout).snapshot_limit).toBe(10);
  });

  test('snapshot POSTs; delete-snapshot and restore need --yes without a terminal', async () => {
    const config = writeConfig(startServer());
    const taken = await runCli(['apps', 'snapshot', 'db', ...P], config);
    expect(taken.code).toBe(0);
    expect(taken.stdout).toContain('snapshot snap-new taken');
    expect(capabilityCalls(`/apps/${DB_ID}/snapshots`).some((c) => c.method === 'POST')).toBe(true);

    calls = [];
    const refused = await runCli(['apps', 'delete-snapshot', 'db', 'snap-1', ...P], config);
    expect(refused.code).not.toBe(0);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const deleted = await runCli(['apps', 'delete-snapshot', 'db', 'snap-1', '--yes', ...P], config);
    expect(deleted.code).toBe(0);
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`/v1/projects/${PROJECT}/apps/${DB_ID}/snapshots/snap-1`);
    const unknown = await runCli(['apps', 'delete-snapshot', 'db', 'nope', '--yes', ...P], config);
    expect(unknown.code).toBe(1);

    calls = [];
    const noRestore = await runCli(['apps', 'restore', 'db', 'snap-auto', ...P], config);
    expect(noRestore.code).not.toBe(0);
    expect(capabilityCalls('/restore')).toEqual([]);
    const restored = await runCli(['apps', 'restore', 'db', 'snap-auto', '--yes', ...P], config);
    expect(restored.code).toBe(0);
    expect(capabilityCalls('/restore')[0]?.body).toEqual({ snapshot_id: 'snap-auto' });
    expect(restored.stdout).toContain('restored db to snap-auto');
  });

  test('credentials prints shell exports that eval back to the exact values', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'credentials', 'db', ...P], config);
    expect(r.code).toBe(0);
    const probe = Bun.spawnSync({
      cmd: ['sh', '-c', `eval "$EXPORTS"; printf %s "$CONVEX_SELF_HOSTED_ADMIN_KEY"`],
      env: { ...process.env, EXPORTS: r.stdout },
    });
    expect(probe.stdout.toString()).toBe(ADMIN_KEY);
    const dotenv = await runCli(['apps', 'credentials', 'db', '--format', 'dotenv', ...P], config);
    expect(dotenv.stdout).toContain('CONVEX_SELF_HOSTED_URL=https://db.apps.example.test');
    const json = await runCli(['apps', 'credentials', 'db', '--format=json', ...P], config);
    expect(JSON.parse(json.stdout).admin_key).toBe(ADMIN_KEY);
    const bad = await runCli(['apps', 'credentials', 'db', '--format', 'xml', ...P], config);
    expect(bad.code).toBe(2);
  });

  test('rotate-credentials --yes POSTs the rotation; without --yes and no terminal it rotates nothing', async () => {
    const config = writeConfig(startServer());
    await runCli(['apps', 'rotate-credentials', 'db', ...P], config);
    expect(capabilityCalls('/rotate-credentials')).toEqual([]);
    const r = await runCli(['apps', 'rotate-credentials', 'db', '--yes', ...P], config);
    expect(r.code).toBe(0);
    expect(capabilityCalls('/rotate-credentials')).toHaveLength(1);
    expect(r.stdout).toContain('kortix apps credentials db');
  });

  test('token prints the JWT alone for any App with member_tokens; --json adds expires_at', async () => {
    const config = writeConfig(startServer());
    const plain = await runCli(['apps', 'token', 'db', ...P], config);
    expect(plain.code).toBe(0);
    expect(plain.stdout.trim()).toBe('h.p.s');
    const asJson = await runCli(['apps', 'token', 'db', '--json', ...P], config);
    expect(JSON.parse(asJson.stdout)).toEqual({ token: 'h.p.s', expires_at: '2026-10-06T01:00:00.000Z' });
  });

  test('logs of an App with the logs capability prints its process log; --lines reaches the API', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'logs', 'db', '--lines', '50', ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('started (50 lines)\nconvex exited 1\n');
    const bad = await runCli(['apps', 'logs', 'db', '--lines', '5000', ...P], config);
    expect(bad.code).toBe(2);
  });

  test('dashboard prints the Kortix Apps page that opens the App', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'dashboard', 'db', ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`https://web.example.test/projects/${PROJECT}/apps?app=${DB_ID}`);
  });

  test('connect prints the snippets for every tab and never reads the admin key', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'connect', 'db', ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kortix apps link <app> --uses db');
    expect(r.stdout).toContain('kortixBinding("db")');
    expect(r.stdout).toContain(`KORTIX_AUTH_JWKS=${ISSUER}/jwks.json`);
    expect(r.stdout).toContain('eval "$(kortix apps credentials db)"');
    expect(r.stdout).not.toContain(ADMIN_KEY);
    expect(capabilityCalls('/credentials')).toEqual([]);
    const json = await runCli(['apps', 'connect', 'db', '--json', ...P], config);
    expect(JSON.parse(json.stdout).snippets.some((s: { id: string }) => s.id === 'app-client')).toBe(true);
  });

  test('delete of an App with snapshots needs its typed slug; the answer names what Kortix keeps', async () => {
    const config = writeConfig(startServer());
    const yesOnly = await runCli(['apps', 'delete', 'db', '--yes', ...P], config);
    expect(yesOnly.code).toBe(2);
    expect(yesOnly.stderr).toContain('--confirm db');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const wrong = await runCli(['apps', 'delete', 'db', '--confirm', 'dbb', ...P], config);
    expect(wrong.code).toBe(2);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const r = await runCli(['apps', 'delete', 'db', '--confirm', 'db', ...P], config);
    expect(r.code).toBe(0);
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.path).toBe(`/v1/projects/${PROJECT}/apps/${DB_ID}`);
    expect(del?.query).toBe('?confirm=db');
    expect(r.stdout).toContain('deleted db');
    expect(r.stdout).toContain('final snapshot snap-final kept until 2026-01-08 00:00 UTC');
  });

  test('deploy --app of a convex App runs convex deploy with its credentials, then records the deployment', async () => {
    const config = writeConfig(startServer());
    const bin = installFakeNpx();
    const log = join(tmp, 'npx.log');
    const project = join(tmp, 'backend');
    mkdirSync(join(project, 'convex'), { recursive: true });
    const r = await runCli(
      ['apps', 'deploy', project, '--app', 'db', ...P, '--', '--typecheck', 'disable'],
      config,
      { PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_LOG: log, CONVEX_DEPLOY_KEY: 'prod:other', CONVEX_DEPLOYMENT: 'dev:other' },
    );
    if (r.code !== 0) console.error(r.stderr);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('convex says hi');
    const lines = readFileSync(log, 'utf8');
    // No local convex: npx runs the CLI version the App pins, never `latest`.
    expect(lines).toContain('args=--yes convex@1.46.0 deploy --typecheck disable');
    expect(lines).toContain('url=https://db.apps.example.test');
    expect(lines).toContain(`key=${ADMIN_KEY}`);
    expect(lines).toContain('deploy_key=unset');
    expect(lines).toContain('deployment=unset');
    expect(lines).toMatch(/cwd=.*\/backend/);
    const record = calls.find((c) => c.method === 'POST' && c.path.endsWith(`/apps/${DB_ID}/deployments`));
    expect(record?.body).toEqual({ source: { kind: 'convex' } });
    expect(r.stdout).toContain('deployed db · v3');
  });

  test('a failed convex deploy returns its exit code and records nothing', async () => {
    const config = writeConfig(startServer());
    const bin = installFakeNpx();
    mkdirSync(join(tmp, 'convex'), { recursive: true });
    const r = await runCli(['apps', 'deploy', '--app', 'db', ...P], config, {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_NPX_LOG: join(tmp, 'npx.log'),
      FAKE_NPX_EXIT: '7',
    });
    expect(r.code).toBe(7);
    expect(calls.some((c) => c.path.endsWith('/deployments'))).toBe(false);
  });

  test('deploy records the git commit as the revision; it prefers the project\'s own convex binary', async () => {
    const config = writeConfig(startServer());
    const project = join(tmp, 'backend');
    mkdirSync(join(project, 'convex'), { recursive: true });
    mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true });
    const local = join(project, 'node_modules', '.bin', 'convex');
    const localLog = join(tmp, 'local.log');
    writeFileSync(local, `#!/bin/sh\necho "args=$*" > "$LOCAL_LOG"\n`);
    chmodSync(local, 0o755);
    const git = (...args: string[]) => Bun.spawnSync({ cmd: ['git', ...args], cwd: project, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } });
    git('init', '-q');
    writeFileSync(join(project, 'convex', 'schema.ts'), 'export default {};\n');
    git('add', 'convex');
    git('commit', '-q', '--no-verify', '-m', 'init');
    const sha = git('rev-parse', 'HEAD').stdout.toString().trim();
    const r = await runCli(['apps', 'deploy', project, '--app', 'db', ...P], config, { LOCAL_LOG: localLog });
    expect(r.code).toBe(0);
    expect(readFileSync(localLog, 'utf8')).toBe('args=deploy\n');
    expect(calls.find((c) => c.path.endsWith(`/apps/${DB_ID}/deployments`))?.body).toEqual({ source: { kind: 'convex', revision: sha } });
  });

  test('a convex/ project with no App of that name says how to create one, and creates nothing', async () => {
    const config = writeConfig(startServer());
    const project = join(tmp, 'crm-db');
    mkdirSync(join(project, 'convex'), { recursive: true });
    const r = await runCli(['apps', 'deploy', project, ...P], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('kortix apps create crm-db --kind convex');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('a web App whose source holds a convex/ folder still deploys as a web App: the target kind decides', async () => {
    const config = writeConfig(startServer());
    const bin = installFakeNpx();
    const log = join(tmp, 'npx.log');
    mkdirSync(join(tmp, 'convex'), { recursive: true });
    writeFileSync(join(tmp, 'index.html'), '<h1>hi</h1>\n');
    const r = await runCli(['apps', 'deploy', '--app', 'site', ...P], config, { PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_LOG: log });
    if (r.code !== 0) console.error(r.stderr);
    expect(r.code).toBe(0);
    expect(calls.some((c) => c.path.endsWith('/apps/artifacts'))).toBe(true);
    expect(calls.find((c) => c.path.endsWith(`/apps/${SITE_ID}/deployments`) && c.method === 'POST')?.body).toMatchObject({ artifact_id: 'art-1' });
    expect(() => readFileSync(log, 'utf8')).toThrow();
  });

  test('deploy with no arguments deploys every manifest App in link order: the used convex App first', async () => {
    rows.delete('db');
    rows.delete('site');
    const config = writeConfig(startServer());
    const bin = installFakeNpx();
    const log = join(tmp, 'npx.log');
    mkdirSync(join(tmp, 'db', 'convex'), { recursive: true });
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'index.html'), '<h1>hi</h1>\n');
    writeFileSync(
      join(tmp, 'kortix.yaml'),
      ['kortix_version: 2', 'apps:', '  site:', '    path: site', '    type: static', '    uses: [db]', '  db:', '    kind: convex', '    path: db', '    resources:', '      cpu: 2', ''].join('\n'),
    );
    const r = await runCli(['apps', 'deploy', ...P], config, { PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_LOG: log });
    if (r.code !== 0) console.error(r.stdout, r.stderr);
    expect(r.code).toBe(0);
    const creates = calls.filter((c) => c.method === 'POST' && c.path === `/v1/projects/${PROJECT}/apps`).map((c) => c.body);
    expect(creates).toEqual([
      { slug: 'db', name: 'db', kind: 'convex', cpu: 2 },
      { slug: 'site', name: 'site', uses: ['db'] },
    ]);
    const records = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/deployments')).map((c) => c.path);
    expect(records).toEqual([`/v1/projects/${PROJECT}/apps/${DB_ID}/deployments`, `/v1/projects/${PROJECT}/apps/${SITE_ID}/deployments`]);
    expect(readFileSync(log, 'utf8')).toMatch(/cwd=.*\/db/);
    expect(r.stdout.indexOf('deployed db')).toBeLessThan(r.stdout.indexOf('site.apps.example.test'));
  });
});
