import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = '11111111-2222-4333-8444-555555555555';
const APP_ID = '99999999-8888-4777-8666-555555555555';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;

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
    'utf8',
  );
  return path;
}

function app(overrides: Record<string, unknown> = {}) {
  return {
    app_id: APP_ID,
    account_id: 'account_1',
    project_id: PROJECT,
    slug: 'storefront',
    name: 'Storefront',
    url: 'https://storefront.kortix.test',
    access_mode: 'private',
    access_revision: 1,
    desired_state: 'running',
    active_deployment_id: null,
    machine: { cpu: 1, memory_gb: 2, disk_gb: 10 },
    idle_timeout_seconds: 300,
    monthly_budget_usd: 5,
    last_request_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === `/v1/projects/${PROJECT}` && req.method === 'GET') {
        return Response.json({
          project_id: PROJECT, account_id: 'account_1', name: 'Atlas', repo_url: 'https://example.test/r.git',
          default_branch: 'main', manifest_path: 'kortix.yaml', status: 'active', metadata: {},
          experimental: { apps: true }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        });
      }
      if (path === `/v1/projects/${PROJECT}/apps` && req.method === 'GET') {
        return Response.json({ apps: [
          app({ desired_state: 'stopped', active_deployment_id: 'deployment_1', hosting_type: 'static' }),
          app({ app_id: SERVER_ID, slug: 'api-server', active_deployment_id: 'deployment_2', hosting_type: 'sandbox', always_on: false }),
          app({ app_id: NEW_ID, slug: 'draft' }),
        ] });
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}/stop` && req.method === 'POST') {
        return Response.json({
          error: 'A static App has no runtime to start or stop. It serves while it has an active deployment; delete the App to take it offline.',
          code: 'static_app_no_runtime',
        }, { status: 409 });
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}/deployments` && req.method === 'GET') {
        return Response.json({ deployments: [] });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

const SERVER_ID = '99999999-8888-4777-8666-555555555556';
const NEW_ID = '99999999-8888-4777-8666-555555555557';

describe('kortix apps: a static App', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-apps-static-'));
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('ls prints static for a static App whatever desired_state says, and undeployed for a new one', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'ls', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/storefront\s+static\s+https:/);
    expect(r.stdout).toMatch(/api-server\s+running\s+https:/);
    expect(r.stdout).toMatch(/draft\s+undeployed\s+https:/);
  });

  test('show names the hosting type', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'show', 'storefront', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('static · served from storage, no runtime');
  });

  test('stop exits 1 and prints the server explanation', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'stop', 'storefront', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A static App has no runtime to start or stop');
  });
});
