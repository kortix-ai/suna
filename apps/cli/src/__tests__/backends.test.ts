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

function backend(overrides: Record<string, unknown> = {}) {
  return {
    backend_id: BACKEND_ID,
    project_id: PROJECT,
    name: 'main',
    status: 'running',
    url: 'https://main.backends.test',
    site_url: 'https://main-site.backends.test',
    cpu: 1,
    memory_gb: 2,
    disk_gb: 10,
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
      const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
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
        return Response.json({ backend: backend({ name: createdName }) });
      }
      if (path === `${base}/backends/${BACKEND_ID}/credentials`) return Response.json(credentials());
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
    for (const sub of ['list | ls', 'create <name>', 'get <name|id>', 'env <name|id>', 'deploy <name>', 'delete <name|id>']) {
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
});
