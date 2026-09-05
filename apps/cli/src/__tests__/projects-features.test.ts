import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_flags';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let patches: Array<{ path: string; body: unknown }> = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_flags',
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

function catalog(overrides: Record<string, boolean | null> = {}) {
  const defs = [
    { key: 'apps', name: 'Apps', stability: 'experimental', available: true, def: false },
    { key: 'monitors', name: 'Monitors', stability: 'experimental', available: false, def: false },
    { key: 'review_center', name: 'Review Center', stability: 'beta', available: true, def: true },
  ];
  return defs.map((d) => {
    const o = overrides[d.key];
    const enabled = d.available && (o === undefined || o === null ? d.def : o);
    return {
      key: d.key,
      name: d.name,
      description: `${d.name} description`,
      stability: d.stability,
      available: d.available,
      enabled,
      overridden: o !== undefined && o !== null,
    };
  });
}

function project(overrides: Record<string, boolean | null> = {}) {
  return {
    project_id: PROJECT,
    account_id: 'account_1',
    name: 'Flags',
    repo_url: 'https://example.test/r.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    experimental_features: catalog(overrides),
  };
}

function startServer(): string {
  const state: Record<string, boolean | null> = {};
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === `/v1/projects/${PROJECT}` && req.method === 'GET') {
        return Response.json(project(state));
      }
      if (url.pathname === `/v1/projects/${PROJECT}/features` && req.method === 'PATCH') {
        const body = (await req.json()) as { feature: string; enabled: boolean | null };
        patches.push({ path: url.pathname, body });
        if (!['apps', 'monitors', 'review_center'].includes(body.feature)) {
          return Response.json({ error: `Unknown feature flag '${body.feature}'` }, { status: 400 });
        }
        if (body.enabled === null) delete state[body.feature];
        else state[body.feature] = body.enabled;
        return Response.json(project(state));
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
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix projects features', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-projects-features-'));
    process.env = { ...ORIGINAL_ENV };
    patches = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents ls/enable/disable/reset', async () => {
    const r = await runCli(['projects', 'features', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('enable <flag>');
    expect(r.stdout).toContain('reset <flag>');
    expect(r.stdout).toContain('project.customize.write');
  });

  test('ls prints every flag with state + origin; --json emits the catalog', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'features', 'ls', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('apps');
    expect(r.stdout).toMatch(/apps\s+off\s+default/);
    expect(r.stdout).toMatch(/review_center\s+on\s+default/);
    expect(r.stdout).toMatch(/monitors\s+n\/a\s+unavailable/);

    const j = await runCli(['projects', 'features', '--project', PROJECT, '--json'], config);
    expect(j.code).toBe(0);
    const rows = JSON.parse(j.stdout) as Array<{ key: string; enabled: boolean }>;
    expect(rows.map((x) => x.key)).toEqual(['apps', 'monitors', 'review_center']);
  });

  test('enable PATCHes /features {feature, enabled:true} and reports the effective state', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'features', 'enable', 'apps', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(patches).toEqual([{ path: `/v1/projects/${PROJECT}/features`, body: { feature: 'apps', enabled: true } }]);
    expect(r.stdout).toContain('apps enabled — effective: on');

    const ls = await runCli(['projects', 'features', '--project', PROJECT], config);
    expect(ls.stdout).toMatch(/apps\s+on\s+override/);
  });

  test('disable then reset clears the override (enabled:null)', async () => {
    const config = writeConfig(startServer());
    const d = await runCli(['projects', 'features', 'disable', 'review_center', '--project', PROJECT], config);
    expect(d.code).toBe(0);
    expect(d.stdout).toContain('review_center disabled — effective: off');
    const rs = await runCli(['projects', 'features', 'reset', 'review_center', '--project', PROJECT], config);
    expect(rs.code).toBe(0);
    expect(rs.stdout).toContain('review_center reset to default — effective: on');
    expect(patches.map((p) => p.body)).toEqual([
      { feature: 'review_center', enabled: false },
      { feature: 'review_center', enabled: null },
    ]);
  });

  test('enabling an unavailable flag warns; unknown flag surfaces the API 400', async () => {
    const config = writeConfig(startServer());
    const u = await runCli(['projects', 'features', 'enable', 'monitors', '--project', PROJECT], config);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain('not available on this host');
    const bad = await runCli(['projects', 'features', 'enable', 'nope', '--project', PROJECT], config);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Unknown feature flag 'nope'");
  });

  test('enable without a flag exits 2 with usage', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['projects', 'features', 'enable', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('requires a <flag>');
  });
});
