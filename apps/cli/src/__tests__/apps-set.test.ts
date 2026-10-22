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
let appOverrides: Record<string, unknown> = {};
let rollbackBody: unknown = null;

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
    always_on: false,
    estimated_monthly_usd: 73.48,
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
        return Response.json({ apps: [app(appOverrides)] });
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
            always_on: (patch.always_on as boolean) ?? false,
            uses: (patch.uses as string[]) ?? [],
          }),
        );
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}/deployments` && req.method === 'GET') {
        return Response.json({
          deployments: [
            { deployment_id: 'dep-v2', version: 2, status: 'ready' },
            { deployment_id: 'dep-v1', version: 1, status: 'ready' },
          ],
        });
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}/rollback` && req.method === 'POST') {
        rollbackBody = await req.json().catch(() => null);
        return Response.json(app({ active_deployment_id: 'dep-v1' }));
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
    appOverrides = {};
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

  test.each(['private', 'project', 'restricted', 'password'])('show explains how to open a %s App without minting a credential', async (mode) => {
    appOverrides = { access_mode: mode };
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'show', 'storefront', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`access        ${mode}`);
    expect(r.stdout).toContain(`kortix apps access-link ${APP_ID} --project ${PROJECT}`);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test.each([
    { access_mode: 'public' },
    { access_mode: 'private', external_url: 'https://external.example.test' },
  ])('show does not suggest a Kortix access link for $access_mode / $external_url', async (overrides) => {
    appOverrides = overrides;
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'show', 'storefront', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('kortix apps access-link');
  });

  test('show keeps an explicitly selected host in the access-link command', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'show', 'storefront', '--project', PROJECT, '--host', 'test'], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`kortix apps access-link ${APP_ID} --project ${PROJECT} --host test`);
  });

  test('show --json remains a credential-free read', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'show', 'storefront', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.stdout)).sort()).toEqual(['app', 'deployments']);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('show prints no budget and no price: an on-demand App runs on demand, an always-on App runs 24/7', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'show', 'storefront', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/budget|cost|\$/);
    expect(r.stdout).toMatch(/runs\s+on demand/);
    const on = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--always-on'], config);
    expect(on.stdout).toMatch(/runs\s+24\/7/);
    expect(on.stdout).not.toMatch(/\$|USD|month/);
  });

  test('set --uses sends the list (deduplicated, trimmed) and prints it; `--uses=` clears it', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--uses', 'db, crm,db'], config);
    expect(r.code).toBe(0);
    expect(patchCall()?.body).toEqual({ uses: ['db', 'crm'] });
    expect(r.stdout).toMatch(/uses\s+db, crm/);

    calls = [];
    const cleared = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--uses='], config);
    expect(cleared.code).toBe(0);
    expect(patchCall()?.body).toEqual({ uses: [] });
    expect(cleared.stdout).toMatch(/uses\s+none/);
  });

  test('set refuses an App slug the API would refuse, before any request', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--uses', 'Main'], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--uses');
    expect(patchCall()).toBeUndefined();
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
    });
  });

  test('set --json emits the updated App', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['apps', 'set', 'storefront', '--project', PROJECT, '--name', 'Shop', '--json'],
      config,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).name).toBe('Shop');
  });

  test('set --always-on / --on-demand send always_on; both at once is refused before any request', async () => {
    const config = writeConfig(startServer());
    const on = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--always-on'], config);
    expect(on.code).toBe(0);
    expect(patchCall()?.body).toEqual({ always_on: true });
    const off = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--on-demand'], config);
    expect(off.code).toBe(0);
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ always_on: false });
    const both = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--always-on', '--on-demand'], config);
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain('not both');
  });

  test('the retired --budget flag is ignored with a notice and never sent; alone it leaves nothing to set', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'set', '--budget', '100', 'storefront', '--project', PROJECT, '--always-on'], config);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('--budget is ignored: Apps have no budget');
    expect(patchCall()?.body).toEqual({ always_on: true });
    const alone = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--budget', '100'], config);
    expect(alone.code).toBe(2);
    expect(alone.stderr).toContain('needs at least one of');
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

  test('set is not gated client-side on the flag (the flag is gone)', async () => {
    // Apps went GA: `apps set` reaches the API on a project whose stored flag
    // is off; the API decides, the CLI does not pre-check.
    appsEnabled = false;
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'set', 'storefront', '--project', PROJECT, '--cpu', '2'], config);
    expect(patchCall()?.body).toMatchObject({ cpu: 2 });
  });
});

describe('kortix apps rollback', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-apps-rollback-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    appsEnabled = true;
    rollbackBody = null;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('accepts a version (v1) as the target, the form `apps show` prints', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'rollback', 'storefront', 'v1', '--project', PROJECT], config);
    expect({ code: r.code, body: rollbackBody }).toEqual({ code: 0, body: { deployment_id: 'dep-v1' } });
  });
});

