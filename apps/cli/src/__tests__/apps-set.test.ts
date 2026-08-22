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
let calls: Array<{ method: string; path: string; body: unknown }> = [];
let appsEnabled = true;

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
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === 'PATCH' ? await req.json().catch(() => null) : null;
      calls.push({ method: req.method, path, body });

      if (path === `/v1/projects/${PROJECT}` && req.method === 'GET') {
        return Response.json({
          project_id: PROJECT,
          account_id: 'account_1',
          name: 'Atlas',
          repo_url: 'https://example.test/r.git',
          default_branch: 'main',
          manifest_path: 'kortix.yaml',
          status: 'active',
          metadata: {},
          experimental: { apps: appsEnabled },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        });
      }
      if (path === `/v1/projects/${PROJECT}/apps` && req.method === 'GET') {
        return Response.json({ apps: [app()] });
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}` && req.method === 'PATCH') {
        const patch = body as Record<string, unknown>;
        if (typeof patch.idle_timeout_seconds === 'number' && patch.idle_timeout_seconds < 120) {
          return Response.json({ error: 'idle_timeout_seconds must be >= 120' }, { status: 400 });
        }
        return Response.json(
          app({
            name: (patch.name as string) ?? 'Storefront',
            machine: {
              cpu: (patch.cpu as number) ?? 1,
              memory_gb: (patch.memory_gb as number) ?? 2,
              disk_gb: (patch.disk_gb as number) ?? 10,
            },
            idle_timeout_seconds: (patch.idle_timeout_seconds as number) ?? 300,
            monthly_budget_usd: (patch.monthly_budget_usd as number) ?? 5,
          }),
        );
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

function patchCall() {
  return calls.find((c) => c.method === 'PATCH');
}

describe('kortix apps set', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-apps-set-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    appsEnabled = true;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents set and keeps the existing subcommands', async () => {
    const r = await runCli(['apps', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('set <id|slug>');
    expect(r.stdout).toContain('--memory-gb <gb>');
    for (const existing of [
      'list | ls',
      'create <slug>',
      'deploy [path]',
      'show <id|slug>',
      'logs <id|slug>',
      'start <id|slug>',
      'stop <id|slug>',
      'rollback <id|slug>',
      'access <id|slug>',
      'access-link <id|slug>',
      'delete <id|slug>',
    ]) {
      expect(r.stdout).toContain(existing);
    }
  });

  test('set PATCHes only the flags passed, resolving the App by slug', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['apps', 'set', 'storefront', '--project', PROJECT, '--cpu', '2', '--memory-gb', '4'],
      config,
    );
    expect(r.code).toBe(0);
    expect(patchCall()).toEqual({
      method: 'PATCH',
      path: `/v1/projects/${PROJECT}/apps/${APP_ID}`,
      body: { cpu: 2, memory_gb: 4 },
    });
    expect(r.stdout).toContain('updated storefront');
    expect(r.stdout).toContain('2 vCPU · 4 GB · 10 GB disk');
  });

  test('set accepts every field and the --memory/--disk aliases', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      [
        'apps',
        'set',
        APP_ID,
        '--project',
        PROJECT,
        '--name',
        'Shop',
        '--cpu',
        '2',
        '--memory',
        '4',
        '--disk',
        '20',
        '--idle-timeout',
        '600',
        '--budget',
        '12.5',
      ],
      config,
    );
    expect(r.code).toBe(0);
    expect(patchCall()?.body).toEqual({
      name: 'Shop',
      cpu: 2,
      memory_gb: 4,
      disk_gb: 20,
      idle_timeout_seconds: 600,
      monthly_budget_usd: 12.5,
    });
  });

  test('set --json emits the updated App', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['apps', 'set', 'storefront', '--project', PROJECT, '--budget', '9', '--json'],
      config,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).monthly_budget_usd).toBe(9);
  });

  test('set with no field flags exits 2 and sends nothing', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'set', 'storefront', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs at least one of');
    expect(patchCall()).toBeUndefined();
  });

  test('set without a target exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'set', '--project', PROJECT, '--cpu', '2'], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('set needs an App id or slug');
  });

  test('a 400 from the API surfaces as exit 1', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['apps', 'set', 'storefront', '--project', PROJECT, '--idle-timeout', '60'],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('idle_timeout_seconds must be >= 120');
  });

  test('set is refused when the Apps flag is off for the project', async () => {
    appsEnabled = false;
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--cpu', '2'], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Apps is not enabled for this project');
    expect(patchCall()).toBeUndefined();
  });
});
