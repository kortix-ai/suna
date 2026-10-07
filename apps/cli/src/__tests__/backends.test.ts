import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderEnv, shellQuote } from '../commands/backends';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = '11111111-2222-4333-8444-555555555555';
const BACKEND_ID = '99999999-8888-4777-8666-555555555555';
const ADMIN_KEY = "main|it's a $key";

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Array<{ method: string; path: string; body: unknown }> = [];
let backendsEnabled = true;
let existing: boolean;

let createdName = 'main';
let size = { cpu: 1, memory_gb: 2, disk_gb: 10 };
let resizePolls = 0;
let snapshots: Array<{ snapshot_id: string; created_at: string; size_bytes: number | null }> = [];
let resizeFailure: string | null = null;
let failResize = false;
let dashboardUrl: string | null = 'https://dev-backend-99999999888847778666555555555555.apps.backends.test';

function backend(overrides: Record<string, unknown> = {}) {
  return {
    backend_id: BACKEND_ID,
    project_id: PROJECT,
    name: 'main',
    status: 'running',
    url: 'https://main.backends.test',
    site_url: 'https://main-site.backends.test',
    dashboard_url: dashboardUrl,
    ...size,
    operation: resizePolls > 0 ? 'resizing' : null,
    last_operation_error: resizeFailure,
    error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const credentials = () => ({
  url: 'https://main.backends.test',
  site_url: 'https://main-site.backends.test',
  admin_key: ADMIN_KEY,
  env: { CONVEX_SELF_HOSTED_URL: 'https://main.backends.test', CONVEX_SELF_HOSTED_ADMIN_KEY: ADMIN_KEY },
});

function startServer(): string {
  const base = `/v1/projects/${PROJECT}`;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const body = req.method === 'POST' || req.method === 'PATCH' ? await req.json().catch(() => null) : null;
      calls.push({ method: req.method, path, body });
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
          experimental: { backends: backendsEnabled },
          dashboard_url: `https://web.backends.test/projects/${PROJECT}`,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        });
      }
      if (path === `${base}/backends` && req.method === 'GET') {
        return Response.json({ backends: existing ? [backend()] : [] });
      }
      if (path === `${base}/backends` && req.method === 'POST') {
        existing = true;
        createdName = (body as { name: string }).name;
        // The real contract: 202 provisioning, then the backend runs.
        return Response.json(
          { backend: backend({ name: (body as { name: string }).name, status: 'provisioning', url: null, site_url: null }) },
          { status: 202 },
        );
      }
      if (path === `${base}/backends/${BACKEND_ID}` && req.method === 'GET') {
        if (resizePolls > 0) resizePolls -= 1;
        if (resizePolls === 0 && failResize) resizeFailure = 'out of capacity';
        return Response.json({ backend: backend({ name: createdName }) });
      }
      if (path === `${base}/backends/${BACKEND_ID}` && req.method === 'PATCH') {
        const want = body as Record<string, number>;
        if (want.disk_gb !== undefined && want.disk_gb < size.disk_gb) {
          return Response.json({ error: 'no shrink', code: 'disk_shrink_unsupported' }, { status: 400 });
        }
        size = { ...size, ...want } as typeof size;
        resizePolls = 2;
        return Response.json({ backend: backend({ operation: 'resizing' }) }, { status: 202 });
      }
      if (path === `${base}/backends/${BACKEND_ID}/backups`) {
        return Response.json({
          automatic: { state: 'ok', last_backup_at: '2026-01-01T00:00:00.000Z', size_bytes: 2048, interval_minutes: 60 },
          snapshots,
        });
      }
      if (path === `${base}/backends/${BACKEND_ID}/snapshots` && req.method === 'POST') {
        return Response.json({ snapshot_id: 'snap-new', created_at: '2026-01-02T00:00:00.000Z' }, { status: 201 });
      }
      if (path === `${base}/backends/${BACKEND_ID}/restore` && req.method === 'POST') {
        return Response.json({ backend: backend() });
      }
      if (path === `${base}/backends/${BACKEND_ID}/credentials`) return Response.json(credentials());
      if (path === `${base}/backends/${BACKEND_ID}/token` && req.method === 'POST') {
        return Response.json({ token: 'h.p.s', expires_at: '2026-10-06T01:00:00.000Z' });
      }
      if (path === `${base}/backends/${BACKEND_ID}` && req.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
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
          token: 'tok_backends',
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
} > "$FAKE_NPX_LOG"
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-backends-'));
  calls = [];
  backendsEnabled = true;
  existing = true;
  size = { cpu: 1, memory_gb: 2, disk_gb: 10 };
  resizePolls = 0;
  resizeFailure = null;
  failResize = false;
  snapshots = [{ snapshot_id: 'snap-1', created_at: '2026-01-01T00:00:00.000Z', size_bytes: 1048576 }];
  dashboardUrl = 'https://dev-backend-99999999888847778666555555555555.apps.backends.test';
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
      `export CONVEX_SELF_HOSTED_URL='https://main.backends.test'\nexport CONVEX_SELF_HOSTED_ADMIN_KEY='main|it'\\''s a $key'\n`,
    );
    expect(renderEnv(c, 'dotenv')).toBe(
      `CONVEX_SELF_HOSTED_URL=https://main.backends.test\nCONVEX_SELF_HOSTED_ADMIN_KEY=${JSON.stringify(ADMIN_KEY)}\n`,
    );
    expect(JSON.parse(renderEnv(c, 'json'))).toEqual(c);
  });
});

describe('kortix backends', () => {
  test('--help lists every subcommand', async () => {
    const r = await runCli(['backends', '--help'], join(tmp, 'none.json'));
    expect(r.code).toBe(0);
    for (const sub of ['list | ls', 'create <name>', 'resize <name|id>', 'backups <name|id>', 'snapshot <name|id>', 'restore <name|id> <snapshot-id>', 'get <name|id>', 'dashboard <name|id>', 'env <name|id>', 'deploy <name>', 'delete <name|id>']) {
      expect(r.stdout).toContain(sub);
    }
  });

  test('list --json and the table', async () => {
    const config = writeConfig(startServer());
    const json = await runCli(['backends', 'list', '--project', PROJECT, '--json'], config);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).backends[0].name).toBe('main');
    const table = await runCli(['backends', 'ls', '--project', PROJECT], config);
    expect(table.stdout).toContain('main');
    expect(table.stdout).toContain('https://main.backends.test');
  });

  test('create POSTs the name; an invalid name never reaches the API', async () => {
    existing = false;
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'create', 'staging', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).backend.name).toBe('staging');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'staging' });
    calls = [];
    const bad = await runCli(['backends', 'create', 'Bad_Name', '--project', PROJECT], config);
    expect(bad.code).toBe(2);
    expect(calls).toEqual([]);
  });

  test('get resolves by name and by id', async () => {
    const config = writeConfig(startServer());
    for (const target of ['main', BACKEND_ID]) {
      const r = await runCli(['backends', 'get', target, '--project', PROJECT, '--json'], config);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).backend.backend_id).toBe(BACKEND_ID);
    }
    const missing = await runCli(['backends', 'get', 'nope', '--project', PROJECT], config);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Backend nope not found');
  });

  test('dashboard prints the Kortix page that frames the Convex dashboard', async () => {
    const config = writeConfig(startServer());
    const page = `https://web.backends.test/projects/${PROJECT}/backends/${BACKEND_ID}`;
    const r = await runCli(['backends', 'dashboard', 'main', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(page);
    expect(r.stderr).not.toContain('dashboard');
    const json = await runCli(['backends', 'dashboard', BACKEND_ID, '--project', PROJECT, '--json'], config);
    expect(JSON.parse(json.stdout)).toMatchObject({ url: page, dashboard_available: true });
    // A backend that predates the dashboard still gets the page, plus the reason it is empty.
    dashboardUrl = null;
    const old = await runCli(['backends', 'dashboard', 'main', '--project', PROJECT], config);
    expect(old.code).toBe(0);
    expect(old.stdout.trim()).toBe(page);
    expect(old.stderr).toContain('created before the dashboard shipped');
  });

  test('env prints shell exports that eval back to the exact values', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'env', 'main', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const probe = Bun.spawnSync({
      cmd: ['sh', '-c', `eval "$EXPORTS"; printf %s "$CONVEX_SELF_HOSTED_ADMIN_KEY"`],
      env: { ...process.env, EXPORTS: r.stdout },
    });
    expect(probe.stdout.toString()).toBe(ADMIN_KEY);
    const dotenv = await runCli(['backends', 'env', 'main', '--format', 'dotenv', '--project', PROJECT], config);
    expect(dotenv.stdout).toContain('CONVEX_SELF_HOSTED_URL=https://main.backends.test');
    const json = await runCli(['backends', 'env', 'main', '--format=json', '--project', PROJECT], config);
    expect(JSON.parse(json.stdout).admin_key).toBe(ADMIN_KEY);
    const bad = await runCli(['backends', 'env', 'main', '--format', 'xml', '--project', PROJECT], config);
    expect(bad.code).toBe(2);
  });

  test('deploy runs npx convex deploy with the backend credentials and returns its exit code', async () => {
    const config = writeConfig(startServer());
    const bin = installFakeNpx();
    const log = join(tmp, 'npx.log');
    const project = join(tmp, 'app');
    mkdirSync(join(project, 'convex'), { recursive: true });
    const r = await runCli(
      ['backends', 'deploy', 'main', '--project', PROJECT, '--dir', project, '--', '--typecheck', 'disable'],
      config,
      {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_NPX_LOG: log,
        FAKE_NPX_EXIT: '7',
        CONVEX_DEPLOY_KEY: 'prod:other',
        CONVEX_DEPLOYMENT: 'dev:other',
      },
    );
    expect(r.code).toBe(7);
    expect(r.stdout).toContain('convex says hi');
    const lines = readFileSync(log, 'utf8');
    expect(lines).toContain('args=--yes convex deploy --typecheck disable');
    expect(lines).toContain('url=https://main.backends.test');
    expect(lines).toContain(`key=${ADMIN_KEY}`);
    expect(lines).toContain('deploy_key=unset');
    expect(lines).toContain('deployment=unset');
    expect(lines).toMatch(/cwd=.*\/app/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('token prints the JWT alone, and --json adds expires_at', async () => {
    existing = true;
    const config = writeConfig(startServer());
    const plain = await runCli(['backends', 'token', 'main', '--project', PROJECT], config);
    expect(plain.code).toBe(0);
    expect(plain.stdout.trim()).toBe('h.p.s');
    const asJson = await runCli(['backends', 'token', 'main', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(asJson.stdout)).toEqual({ token: 'h.p.s', expires_at: '2026-10-06T01:00:00.000Z' });
  });

  test('deploy creates the backend when it does not exist', async () => {
    existing = false;
    const config = writeConfig(startServer());
    const bin = installFakeNpx();
    const log = join(tmp, 'npx.log');
    writeFileSync(join(tmp, 'convex.json'), '{}');
    const r = await runCli(['backends', 'deploy', 'main', '--project', PROJECT], config, {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_NPX_LOG: log,
    });
    if (r.code !== 0) console.error(`deploy exited ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('created backend main');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'main' });
    expect(readFileSync(log, 'utf8')).toContain('args=--yes convex deploy\n');
  });

  test('deploy refuses a directory with no convex/ and no convex.json, before any API call', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'deploy', 'main', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no convex/ folder and no convex.json');
    expect(calls).toEqual([]);
  });

  test('delete --yes DELETEs; without --yes and no terminal it deletes nothing', async () => {
    const config = writeConfig(startServer());
    const refused = await runCli(['backends', 'delete', 'main', '--project', PROJECT], config);
    expect(refused.code).not.toBe(0);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const r = await runCli(['backends', 'delete', 'main', '--yes', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('deleted main');
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`/v1/projects/${PROJECT}/backends/${BACKEND_ID}`);
  });

  test('a project without the backends flag stops before listing', async () => {
    backendsEnabled = false;
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'list', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Backends is not enabled');
    expect(calls.some((c) => c.path.endsWith('/backends'))).toBe(false);
  });

  test('create passes --cpu, --memory and --disk; a bad value never reaches the API', async () => {
    existing = false;
    const config = writeConfig(startServer());
    const r = await runCli(
      ['backends', 'create', 'big', '--cpu', '4', '--memory', '8', '--disk', '40', '--project', PROJECT, '--json'],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/backends'))?.body).toEqual({
      name: 'big',
      cpu: 4,
      memory_gb: 8,
      disk_gb: 40,
    });
    calls = [];
    const bad = await runCli(['backends', 'create', 'x', '--cpu', '99', '--project', PROJECT], config);
    expect(bad.code).toBe(2);
    expect(calls).toEqual([]);
  });

  test('resize PATCHes only the given fields, waits for the operation, prints the new size', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'resize', 'main', '--cpu', '2', '--memory', '4', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ cpu: 2, memory_gb: 4 });
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith(BACKEND_ID)).length).toBeGreaterThan(1);
    expect(r.stdout).toContain('2 vCPU · 4 GB · 10 GB disk');
  });

  test('resize --no-wait returns at once; resize without a size or with a bad size fails before the API', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'resize', 'main', '--disk', '20', '--no-wait', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).backend.operation).toBe('resizing');
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith(BACKEND_ID))).toHaveLength(0);
    calls = [];
    const none = await runCli(['backends', 'resize', 'main', '--project', PROJECT], config);
    expect(none.code).toBe(2);
    const bad = await runCli(['backends', 'resize', 'main', '--memory', 'lots', '--project', PROJECT], config);
    expect(bad.code).toBe(2);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('resize shows the API error code for a disk shrink', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'resize', 'main', '--disk', '5', '--project', PROJECT], config);
    expect(r.code).not.toBe(0);
  });

  test('resize exits 1 with last_operation_error when the operation fails', async () => {
    const config = writeConfig(startServer());
    failResize = true;
    const r = await runCli(['backends', 'resize', 'main', '--cpu', '2', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('out of capacity');
  });

  test('backups prints the automatic backup line and a snapshot table; --json is the raw payload', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'backups', 'main', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('automatic');
    expect(r.stdout).toContain('every 60 min');
    expect(r.stdout).toContain('snap-1');
    expect(r.stdout).toContain('1.0 MB');
    const json = await runCli(['backends', 'backups', 'main', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(json.stdout).snapshots[0].snapshot_id).toBe('snap-1');
  });

  test('snapshot POSTs and prints the snapshot id', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['backends', 'snapshot', 'main', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('snap-new');
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/snapshots'))).toBeDefined();
    const json = await runCli(['backends', 'snapshot', 'main', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(json.stdout).snapshot_id).toBe('snap-new');
  });

  test('restore --yes POSTs the snapshot id; without --yes and no terminal it restores nothing', async () => {
    const config = writeConfig(startServer());
    const refused = await runCli(['backends', 'restore', 'main', 'snap-1', '--project', PROJECT], config);
    expect(refused.code).not.toBe(0);
    expect(calls.some((c) => c.path.endsWith('/restore'))).toBe(false);
    const r = await runCli(['backends', 'restore', 'main', 'snap-1', '--yes', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('restored main');
    expect(calls.find((c) => c.path.endsWith('/restore'))?.body).toEqual({ snapshot_id: 'snap-1' });
    const missing = await runCli(['backends', 'restore', 'main', '--yes', '--project', PROJECT], config);
    expect(missing.code).toBe(2);
  });
});
